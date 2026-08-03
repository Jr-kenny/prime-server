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
  constructor({ baseUrl, wallet, token = null, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error("Prime Server baseUrl is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is required");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.wallet = wallet;
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

  async put(name, body, { expiresAt, expirationSeconds, contentType = "application/octet-stream" } = {}) {
    const headers = { "content-type": contentType };
    if (expiresAt !== undefined) headers["x-prime-expires-at"] = String(expiresAt);
    if (expirationSeconds !== undefined) headers["x-prime-expiration-seconds"] = String(expirationSeconds);
    const account = walletAddress(this.wallet);
    const response = await this.request(`/blobs/${encodePath(account)}/${encodePath(name)}`, {
      method: "PUT",
      headers,
      body,
      auth: true
    });
    return response.json();
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
