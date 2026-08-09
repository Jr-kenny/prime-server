import { createHash } from "node:crypto";
import { blobBytes, prepareBlob as prepareBlobInput } from "./prepare.mjs";
import { createDeviceKeyPair, deviceKeyCommitment, prepareEncryptedBlob as prepareEncryptedBlobInput } from "./encryption.mjs";
import { canonicalJson, normalizePolicy, resolveStorageMode, ZERO_BYTES32 } from "./policy.mjs";
import { primeServerRegistryAbi } from "./registry-abi.mjs";

const primeServerFccSenderAbi = [
  {
    type: "function",
    name: "requestConfidentialCompute",
    stateMutability: "payable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "keyEnvelope", type: "bytes" },
      { name: "computeSpec", type: "bytes" },
      { name: "inputCommitment", type: "bytes32" }
    ],
    outputs: [{ name: "instructionId", type: "bytes32" }]
  }
];

const primeServerFccVerifierAbi = [{
  type: "function",
  name: "submitResult",
  stateMutability: "nonpayable",
  inputs: [
    { name: "requestId", type: "bytes32" },
    { name: "resultData", type: "bytes" },
    { name: "actionId", type: "bytes32" },
    { name: "submissionTag", type: "string" },
    { name: "status", type: "uint8" },
    { name: "signature", type: "bytes" }
  ],
  outputs: []
}];

function encodePath(value) {
  return encodeURIComponent(String(value));
}

async function readError(response) {
  try {
    const body = await response.json();
    return body?.error || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function walletAddress(wallet) {
  const address = wallet?.address || wallet?.account?.address;
  if (!address) throw new Error("wallet must expose an address");
  return address;
}

function tupleValue(raw, name, index) {
  return raw?.[name] ?? raw?.[index];
}

function bytesHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function sha256Hex(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function decodeJsonBytes(value, field) {
  try {
    return JSON.parse(Buffer.from(String(value).replace(/^0x/, ""), "hex").toString("utf8"));
  } catch (error) {
    throw new Error(`${field} is not valid JSON bytes: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function instructionIdFromReceipt(receipt, requestId, senderAddress) {
  for (const log of receipt?.logs || []) {
    if (String(log.address || "").toLowerCase() !== String(senderAddress).toLowerCase()) continue;
    const topics = log.topics || [];
    if (topics.length >= 4 && String(topics[1]).toLowerCase() === String(requestId).toLowerCase()) return topics[3];
  }
  throw new Error("FCC instruction event was not found in the sender receipt");
}

function actionResultFromProxy(proxyResponse) {
  const actionResult = proxyResponse?.result || proxyResponse?.Result;
  const signature = proxyResponse?.signature || proxyResponse?.Signature;
  if (!actionResult || !signature) throw new Error("FCC proxy result did not include a signed ActionResult");
  if (Number(actionResult.status) !== 1) throw new Error(`FCC action failed with status ${actionResult.status}`);
  return { actionResult, signature };
}

function normalizeQuote(raw) {
  return {
    total: BigInt(tupleValue(raw, "total", 0)),
    providerPool: BigInt(tupleValue(raw, "providerPool", 1)),
    protocolFee: BigInt(tupleValue(raw, "protocolFee", 2)),
    providerRewardPerShard: BigInt(tupleValue(raw, "providerRewardPerShard", 3)),
    quoteCommitment: tupleValue(raw, "quoteCommitment", 4)
  };
}

function accessPurpose(value = "view") {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "view") return 0;
    if (normalized === "compute" || normalized === "compute_only") return 1;
  }
  const number = Number(value);
  if (number === 0 || number === 1) return number;
  throw new Error("purpose must be view or compute");
}

async function signTypedData(signer, account, params) {
  if (typeof signer?.signTypedData !== "function") throw new Error("wallet client must expose signTypedData for confidential access authorization");
  try {
    return await signer.signTypedData({ account, ...params });
  } catch (firstError) {
    return signer.signTypedData(params).catch(() => { throw firstError; });
  }
}

async function signMessage(wallet, message) {
  if (typeof wallet?.signMessage !== "function") throw new Error("wallet must expose signMessage");
  try {
    return await wallet.signMessage({ message });
  } catch (firstError) {
    if (!wallet.account) throw firstError;
    return wallet.signMessage({ account: wallet.account, message });
  }
}

export class PrimeServerError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = "PrimeServerError";
    this.status = status;
    this.response = response;
  }
}

export class PrimeServerClient {
  constructor({
    baseUrl,
    wallet,
    walletClient,
    publicClient,
    registryAddress,
    registryAbi = primeServerRegistryAbi,
    chainId,
    token = null,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (!baseUrl) throw new Error("Prime Server baseUrl is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is required");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.wallet = wallet;
    this.walletClient = walletClient;
    this.publicClient = publicClient;
    this.registryAddress = registryAddress;
    this.registryAbi = registryAbi;
    this.chainId = chainId;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", headers = {}, body, auth = false } = {}) {
    if (auth && !this.token) await this.authenticate();
    const requestHeaders = new Headers(headers);
    if (this.token) requestHeaders.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, { method, headers: requestHeaders, body });
    if (!response.ok) throw new PrimeServerError(await readError(response), response.status, response);
    return response;
  }

  async authenticate() {
    const address = walletAddress(this.wallet);
    const challengeResponse = await this.request(`/auth/challenge?address=${encodePath(address)}`);
    const challenge = await challengeResponse.json();
    const signature = await signMessage(this.wallet, challenge.message);
    const sessionResponse = await this.request("/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, nonce: challenge.nonce, signature })
    });
    const session = await sessionResponse.json();
    this.token = session.token;
    return session;
  }

  async serviceInfo() {
    return (await this.request("/")).json();
  }

  async account() {
    return (await this.request("/account", { auth: true })).json();
  }

  async prepareBlob(input, options = {}) {
    return prepareBlobInput(input, options);
  }

  async prepareEncryptedBlob(input, options = {}) {
    const owner = options.owner || walletAddress(this.wallet || this.walletClient);
    return prepareEncryptedBlobInput(input, { ...options, owner });
  }

  createDeviceKeyPair() {
    return createDeviceKeyPair();
  }

  async prepareConfidentialAccessRequest({ blobId, devicePublicKey, deviceKeyCommitment: providedCommitment, purpose = "view", deadline, nonce } = {}) {
    if (!this.registryAddress || !this.publicClient) throw new Error("registryAddress and publicClient are required for confidential access authorization");
    const requester = walletAddress(this.wallet || this.walletClient);
    const resolvedDeviceKeyCommitment = providedCommitment || deviceKeyCommitment(devicePublicKey);
    if (!/^0x[a-fA-F0-9]{64}$/.test(resolvedDeviceKeyCommitment)) throw new Error("deviceKeyCommitment must be a 32-byte hex value");
    const resolvedNonce = nonce === undefined
      ? BigInt(await this.publicClient.readContract({
        address: this.registryAddress,
        abi: this.registryAbi,
        functionName: "confidentialAccessNonces",
        args: [blobId, requester]
      }))
      : BigInt(nonce);
    const resolvedDeadline = deadline === undefined
      ? BigInt(Math.floor(Date.now() / 1000) + 600)
      : BigInt(deadline);
    const request = {
      blobId,
      requester,
      deviceKeyCommitment: resolvedDeviceKeyCommitment,
      nonce: resolvedNonce,
      deadline: resolvedDeadline,
      purpose: accessPurpose(purpose),
      exists: false,
      consumed: false
    };
    const chainId = this.chainId ?? await this.publicClient.getChainId();
    const domain = {
      name: "Prime Server Registry",
      version: "1",
      chainId,
      verifyingContract: this.registryAddress
    };
    const types = {
      ConfidentialAccess: [
        { name: "blobId", type: "bytes32" },
        { name: "requester", type: "address" },
        { name: "deviceKeyCommitment", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "purpose", type: "uint8" }
      ]
    };
    const account = this.walletClient?.account || this.wallet?.account || requester;
    const signature = await signTypedData(this.walletClient || this.wallet, account, {
      domain,
      types,
      primaryType: "ConfidentialAccess",
      message: request
    });
    return { request, signature, domain, types };
  }

  async authorizeConfidentialAccess({ request, signature, blobId, devicePublicKey, deviceKeyCommitment: providedCommitment, purpose = "view", deadline, nonce } = {}) {
    if (!this.registryAddress || !this.walletClient || !this.publicClient) throw new Error("registryAddress, walletClient, and publicClient are required for confidential access authorization");
    const prepared = request && signature
      ? { request, signature }
      : await this.prepareConfidentialAccessRequest({ blobId: request?.blobId || blobId, devicePublicKey, deviceKeyCommitment: providedCommitment, purpose, deadline, nonce });
    const account = this.walletClient.account || this.wallet?.account || walletAddress(this.wallet || this.walletClient);
    const digest = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: this.registryAbi,
      functionName: "hashConfidentialAccess",
      args: [prepared.request]
    });
    const hash = await this.walletClient.writeContract({
      address: this.registryAddress,
      abi: this.registryAbi,
      functionName: "authorizeConfidentialAccess",
      account,
      args: [prepared.request, prepared.signature]
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt?.status && receipt.status !== "success") throw new Error("confidential access authorization transaction failed");
    return { ...prepared, requestId: digest, hash, receipt };
  }

  async fccInfo() {
    return (await this.request("/fcc/info", { auth: true })).json();
  }

  async waitForFccActionResult(instructionId, { timeoutMs = 180_000, pollMs = 2_000 } = {}) {
    if (!this.token) await this.authenticate();
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
      const response = await this.fetch(`${this.baseUrl}/fcc/result/${encodePath(instructionId)}`, {
        headers: { authorization: `Bearer ${this.token}` }
      });
      lastStatus = response.status;
      if (response.ok) return response.json();
      if (response.status !== 202 && response.status !== 404) throw new PrimeServerError(await readError(response), response.status, response);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`timed out waiting for FCC result for ${instructionId}, last HTTP status ${lastStatus}`);
  }

  async confidentialCompute({
    prepared,
    senderAddress,
    verifierAddress,
    operation = "sha256",
    field,
    inputCommitment,
    instructionFee = 1_000_000n,
    accessDeadline,
    timeoutMs = 180_000
  } = {}) {
    if (!prepared?.blobId || !prepared?.keyEnvelope || !prepared?.ciphertext) throw new Error("prepared confidential blob is incomplete");
    if (!senderAddress || !verifierAddress) throw new Error("senderAddress and verifierAddress are required for confidential compute");
    if (!this.walletClient || !this.publicClient || !this.registryAddress) {
      throw new Error("walletClient, publicClient, and registryAddress are required for confidential compute");
    }

    const device = this.createDeviceKeyPair();
    const access = await this.authorizeConfidentialAccess({
      blobId: prepared.blobId,
      devicePublicKey: device.publicKey,
      purpose: "compute",
      deadline: accessDeadline
    });
    const computeSpec = { operation: String(operation).toLowerCase() };
    if (field) computeSpec.field = String(field);
    const computeSpecBytes = Buffer.from(canonicalJson(computeSpec), "utf8");
    const ciphertext = Buffer.from(prepared.ciphertext);
    const resolvedInputCommitment = inputCommitment || sha256Hex(ciphertext);
    const keyEnvelopeBytes = Buffer.from(canonicalJson(prepared.keyEnvelope), "utf8");
    const account = this.walletClient.account || this.wallet?.account || walletAddress(this.wallet || this.walletClient);
    const requestHash = await this.walletClient.writeContract({
      address: senderAddress,
      abi: primeServerFccSenderAbi,
      functionName: "requestConfidentialCompute",
      account,
      args: [access.requestId, bytesHex(keyEnvelopeBytes), bytesHex(computeSpecBytes), resolvedInputCommitment],
      value: BigInt(instructionFee)
    });
    const requestReceipt = await this.publicClient.waitForTransactionReceipt({ hash: requestHash });
    if (requestReceipt?.status && requestReceipt.status !== "success") throw new Error("FCC compute request transaction failed");
    const instructionId = instructionIdFromReceipt(requestReceipt, access.requestId, senderAddress);
    const proxyResponse = await this.waitForFccActionResult(instructionId, { timeoutMs });
    const { actionResult, signature } = actionResultFromProxy(proxyResponse);
    if (String(actionResult.id).toLowerCase() !== String(instructionId).toLowerCase()) throw new Error("FCC result instruction binding mismatch");
    const result = decodeJsonBytes(actionResult.data, "FCC result data");
    if (String(result.requestId).toLowerCase() !== String(access.requestId).toLowerCase()) throw new Error("FCC result request binding mismatch");
    if (String(result.blobId).toLowerCase() !== String(prepared.blobId).toLowerCase()) throw new Error("FCC result blob binding mismatch");

    const submitHash = await this.walletClient.writeContract({
      address: verifierAddress,
      abi: primeServerFccVerifierAbi,
      functionName: "submitResult",
      account,
      args: [
        access.requestId,
        actionResult.data,
        actionResult.id,
        actionResult.submissionTag,
        Number(actionResult.status),
        signature
      ]
    });
    const submitReceipt = await this.publicClient.waitForTransactionReceipt({ hash: submitHash });
    if (submitReceipt?.status && submitReceipt.status !== "success") throw new Error("FCC result verification transaction failed");
    return {
      requestId: access.requestId,
      instructionId,
      requestHash,
      submitHash,
      actionResult,
      result,
      access
    };
  }

  async registerBlob(prepared) {
    if (!this.registryAddress || !this.walletClient) throw new Error("registryAddress and walletClient are required for direct blob registration");
    if (!this.publicClient) throw new Error("publicClient is required to confirm blob registration before upload");
    if (!prepared?.blobId || !prepared.name || !prepared.commitment) throw new Error("prepared blob metadata is incomplete");
    const account = this.walletClient.account || this.wallet?.account || this.wallet?.address;
    if (!account) throw new Error("wallet account is required for direct blob registration");
    const hash = await this.walletClient.writeContract({
      address: this.registryAddress,
      abi: this.registryAbi,
      functionName: "createBlobNamed",
      account,
      args: [
        prepared.blobId,
        prepared.name,
        prepared.commitment,
        BigInt(prepared.size),
        Number(prepared.chunkSize),
        Number(prepared.dataShards),
        Number(prepared.totalShards),
        BigInt(prepared.expiresAt)
      ]
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt?.status && receipt.status !== "success") throw new Error("blob registration transaction failed");
    return { hash, receipt };
  }

  async quoteNativePayment({ size, totalShards, storageMode = "public", expiresAt } = {}) {
    if (!this.registryAddress || !this.publicClient) throw new Error("registryAddress and publicClient are required for payment quotes");
    if (!Number.isSafeInteger(Number(size)) || Number(size) <= 0) throw new Error("size must be a positive integer");
    if (!Number.isSafeInteger(Number(totalShards)) || Number(totalShards) <= 0) throw new Error("totalShards must be a positive integer");
    if (!Number.isSafeInteger(Number(expiresAt)) || Number(expiresAt) <= Math.floor(Date.now() / 1000)) throw new Error("expiresAt must be a future UNIX timestamp");
    const raw = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: this.registryAbi,
      functionName: "quoteNativePayment",
      args: [BigInt(size), Number(totalShards), resolveStorageMode(storageMode), BigInt(expiresAt)]
    });
    return normalizeQuote(raw);
  }

  async registerPaidBlob(prepared, options = {}) {
    if (!this.registryAddress || !this.walletClient) throw new Error("registryAddress and walletClient are required for direct paid blob registration");
    if (!this.publicClient) throw new Error("publicClient is required to confirm paid blob registration before upload");
    if (!prepared?.blobId || !prepared.name || !prepared.commitment) throw new Error("prepared blob metadata is incomplete");
    if (!prepared.expiresAt) throw new Error("paid blob registration requires a future expiry");
    const policy = normalizePolicy({ ...(prepared.policy || {}), ...(options.policy || {}), ...options });
    if (policy.storageMode !== 0 && prepared.name !== `private/${prepared.blobId.replace(/^0x/, "")}`) {
      throw new Error("private and confidential paid blobs require an opaque SDK-generated name");
    }
    const quote = options.quote || await this.quoteNativePayment({
      size: prepared.size,
      totalShards: prepared.totalShards,
      storageMode: policy.storageMode,
      expiresAt: prepared.expiresAt
    });
    const value = options.value === undefined ? quote.total : BigInt(options.value);
    if (value < quote.total) throw new Error("native payment value is below the current quote");
    const account = this.walletClient.account || this.wallet?.account || this.wallet?.address;
    if (!account) throw new Error("wallet account is required for direct paid blob registration");
    const registration = {
      blobId: prepared.blobId,
      blobName: prepared.name,
      commitment: prepared.commitment,
      size: BigInt(prepared.size),
      chunkSize: Number(prepared.chunkSize),
      dataShards: Number(prepared.dataShards),
      totalShards: Number(prepared.totalShards),
      expiresAt: BigInt(prepared.expiresAt),
      storageMode: policy.storageMode,
      accessPolicy: policy.accessPolicy,
      policyCommitment: policy.policyCommitment,
      keyEnvelopeCommitment: policy.keyEnvelopeCommitment || ZERO_BYTES32,
      metadataCommitment: policy.metadataCommitment || ZERO_BYTES32
    };
    const hash = await this.walletClient.writeContract({
      address: this.registryAddress,
      abi: this.registryAbi,
      functionName: "createBlobNamedPaid",
      account,
      args: [registration],
      value
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt?.status && receipt.status !== "success") throw new Error("paid blob registration transaction failed");
    prepared.policy = policy;
    prepared.payment = {
      asset: "native_flare",
      status: "escrowed",
      totalPaid: value,
      ...quote
    };
    return { hash, receipt, registration, policy, payment: prepared.payment, quote };
  }

  async uploadRegisteredBlob(prepared, body, { contentType = "application/octet-stream", policy = prepared?.policy } = {}) {
    if (!prepared?.blobId || !prepared.name || !prepared.commitment) throw new Error("prepared blob metadata is incomplete");
    const input = await blobBytes(body);
    if (input.length !== prepared.size) throw new Error("upload body does not match the prepared blob size");
    const account = walletAddress(this.wallet || this.walletClient);
    const headers = { "content-type": contentType, "content-length": String(input.length) };
    headers["x-prime-blob-id"] = prepared.blobId;
    headers["x-prime-commitment"] = prepared.commitment;
    headers["x-prime-chunk-size"] = String(prepared.chunkSize);
    headers["x-prime-data-shards"] = String(prepared.dataShards);
    headers["x-prime-total-shards"] = String(prepared.totalShards);
    headers["x-prime-expires-at"] = String(prepared.expiresAt);
    if (policy) {
      const normalizedPolicy = normalizePolicy(policy);
      headers["x-prime-storage-mode"] = String(normalizedPolicy.storageMode);
      headers["x-prime-access-policy"] = String(normalizedPolicy.accessPolicy);
      headers["x-prime-policy-commitment"] = normalizedPolicy.policyCommitment;
      headers["x-prime-key-envelope-commitment"] = normalizedPolicy.keyEnvelopeCommitment;
      headers["x-prime-metadata-commitment"] = normalizedPolicy.metadataCommitment;
    }
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(prepared.name)}`, {
      method: "PUT",
      headers,
      body: input,
      auth: true
    });
    return response.json();
  }

  async put(name, body, { expiresAt, expirationSeconds, contentType = "application/octet-stream", paid = false, ...paidOptions } = {}) {
    const input = await blobBytes(body);
    const prepared = await this.prepareBlob(input, { name, expiresAt, expirationSeconds });
    if (paid) await this.registerPaidBlob(prepared, paidOptions);
    else await this.registerBlob(prepared);
    return this.uploadRegisteredBlob(prepared, input, { contentType });
  }

  async putPaid(name, body, { expiresAt, expirationSeconds, contentType = "application/octet-stream", ...paymentOptions } = {}) {
    return this.put(name, body, {
      expiresAt,
      expirationSeconds,
      contentType,
      paid: true,
      ...paymentOptions
    });
  }

  async list({ prefix = "", limit = 100, cursor = "" } = {}) {
    const account = walletAddress(this.wallet);
    const query = new URLSearchParams({ limit: String(limit) });
    if (prefix) query.set("prefix", prefix);
    if (cursor) query.set("cursor", cursor);
    return (await this.request(`/blobs/${encodePath(account)}?${query}`, { auth: true })).json();
  }

  async head(name, { account = walletAddress(this.wallet), accessRequestId } = {}) {
    const headers = accessRequestId ? { "x-prime-access-request-id": accessRequestId } : {};
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(name)}`, { method: "HEAD", headers, auth: true });
    return {
      size: Number(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      blobId: response.headers.get("x-prime-blob-id"),
      nameHash: response.headers.get("x-prime-name-hash"),
      expiresAt: Number(response.headers.get("x-prime-expires-at"))
    };
  }

  async get(name, { range, account = walletAddress(this.wallet), accessRequestId } = {}) {
    const headers = range ? { range } : {};
    if (accessRequestId) headers["x-prime-access-request-id"] = accessRequestId;
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(name)}`, {
      headers,
      auth: true
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentRange: response.headers.get("content-range"),
      blobId: response.headers.get("x-prime-blob-id"),
      bytes: new Uint8Array(await response.arrayBuffer())
    };
  }
}

export function createPrimeServerClient(options) {
  return new PrimeServerClient(options);
}
