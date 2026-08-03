import { blobBytes, prepareBlob as prepareBlobInput } from "./prepare.mjs";
import { createDeviceKeyPair, deviceKeyCommitment, prepareEncryptedBlob as prepareEncryptedBlobInput } from "./encryption.mjs";
import { normalizePolicy, resolveStorageMode, ZERO_BYTES32 } from "./policy.mjs";
import { primeServerRegistryAbi } from "./registry-abi.mjs";

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
