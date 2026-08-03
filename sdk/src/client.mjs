import { blobBytes, prepareBlob as prepareBlobInput } from "./prepare.mjs";
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

  async registerBlob(prepared) {
    if (!this.registryAddress || !this.walletClient) throw new Error("registryAddress and walletClient are required for direct blob registration");
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
    const receipt = this.publicClient
      ? await this.publicClient.waitForTransactionReceipt({ hash })
      : null;
    return { hash, receipt };
  }

  async uploadRegisteredBlob(prepared, body, { contentType = "application/octet-stream" } = {}) {
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
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(prepared.name)}`, {
      method: "PUT",
      headers,
      body: input,
      auth: true
    });
    return response.json();
  }

  async put(name, body, { expiresAt, expirationSeconds, contentType = "application/octet-stream" } = {}) {
    const input = await blobBytes(body);
    const prepared = await this.prepareBlob(input, { name, expiresAt, expirationSeconds });
    await this.registerBlob(prepared);
    return this.uploadRegisteredBlob(prepared, input, { contentType });
  }

  async list({ prefix = "", limit = 100, cursor = "" } = {}) {
    const account = walletAddress(this.wallet);
    const query = new URLSearchParams({ limit: String(limit) });
    if (prefix) query.set("prefix", prefix);
    if (cursor) query.set("cursor", cursor);
    return (await this.request(`/blobs/${encodePath(account)}?${query}`, { auth: true })).json();
  }

  async head(name) {
    const account = walletAddress(this.wallet);
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(name)}`, { method: "HEAD", auth: true });
    return {
      size: Number(response.headers.get("content-length")),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      blobId: response.headers.get("x-prime-blob-id"),
      nameHash: response.headers.get("x-prime-name-hash"),
      expiresAt: Number(response.headers.get("x-prime-expires-at"))
    };
  }

  async get(name, { range } = {}) {
    const account = walletAddress(this.wallet);
    const headers = range ? { range } : {};
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
