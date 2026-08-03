import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createErasureEngine, FOUR_PROVIDER_CONFIG } from "../../provider/src/erasure.mjs";
import { getAddress, isAddress, keccak256, stringToHex } from "viem";
import { bearerToken } from "./auth.mjs";

export const MAX_BODY_BYTES = FOUR_PROVIDER_CONFIG.k * FOUR_PROVIDER_CONFIG.chunkSizeBytes;
export const DEVELOPER_API_PREFIX = "/prime/v1";

class GatewayError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    ...extraHeaders
  });
  res.end(payload);
}

async function readRequestBody(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("blob is larger than the first chunkset capacity");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("blob is larger than the first chunkset capacity");
    chunks.push(chunk);
  }
  if (total === 0) throw new Error("blob body is required");
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  let body;
  try {
    body = JSON.parse((await readRequestBody(req)).toString("utf8"));
  } catch {
    throw new GatewayError(400, "request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayError(400, "request body must be a JSON object");
  return body;
}

function normalizeAccount(value) {
  if (!isAddress(value || "")) throw new GatewayError(400, "a valid wallet account is required");
  return getAddress(value);
}

function normalizeBlobName(value) {
  let name;
  try {
    name = decodeURIComponent(value || "");
  } catch {
    throw new GatewayError(400, "blob name is not valid URL encoding");
  }
  if (!name || Buffer.byteLength(name, "utf8") > 1024 || name.includes("\0") || name.startsWith("/") || name.endsWith("/")) {
    throw new GatewayError(400, "blob name must be between 1 and 1024 bytes and cannot end with a slash");
  }
  return name;
}

function parseDeveloperBlobPath(pathname) {
  const prefix = `${DEVELOPER_API_PREFIX}/blobs/`;
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  const accountPart = separator === -1 ? remainder : remainder.slice(0, separator);
  const account = normalizeAccount(decodeURIComponent(accountPart));
  return {
    account,
    name: separator === -1 ? null : normalizeBlobName(remainder.slice(separator + 1))
  };
}

function requireSession(request, authManager) {
  if (!authManager) throw new GatewayError(503, "developer API authentication is not configured");
  try {
    return authManager.verifyToken(bearerToken(request));
  } catch (error) {
    throw new GatewayError(401, error instanceof Error ? error.message : "authentication required", {
      "www-authenticate": "Bearer"
    });
  }
}

function requireAccountOwner(session, account) {
  if (session.address.toLowerCase() !== account.toLowerCase()) throw new GatewayError(403, "wallet does not own this account");
}

function parseExpiration(request) {
  const expiresAtHeader = request.headers["x-prime-expires-at"];
  const expirationSecondsHeader = request.headers["x-prime-expiration-seconds"];
  const now = Math.floor(Date.now() / 1000);
  let expiresAt;
  if (expiresAtHeader !== undefined) {
    expiresAt = Number(expiresAtHeader);
  } else if (expirationSecondsHeader !== undefined) {
    expiresAt = now + Number(expirationSecondsHeader);
  } else {
    throw new GatewayError(400, "x-prime-expires-at or x-prime-expiration-seconds is required");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new GatewayError(400, "blob expiration must be a future UNIX timestamp");
  return expiresAt;
}

function objectResponse(object, requestUrl, publicBaseUrl = "") {
  const apiBase = publicBaseUrl || `${requestUrl.origin}${DEVELOPER_API_PREFIX}`;
  return {
    account: object.account,
    name: object.name,
    blobId: object.blobId,
    size: object.size,
    contentType: object.contentType,
    commitment: object.commitment,
    nameHash: object.nameHash,
    createdAt: object.createdAt,
    expiresAt: object.expiresAt,
    status: object.status,
    downloadUrl: `${apiBase}/blobs/${object.account}/${encodeURIComponent(object.name)}`
  };
}

function objectHeaders(object) {
  return {
    "content-type": object.contentType || "application/octet-stream",
    "content-length": object.size,
    etag: `"${object.commitment}"`,
    "x-prime-blob-id": object.blobId,
    "x-prime-name-hash": object.nameHash || "",
    "x-prime-expires-at": String(object.expiresAt),
    "accept-ranges": "bytes"
  };
}

function applyCorsHeaders(response, origin) {
  response.setHeader("access-control-allow-origin", origin || "*");
  response.setHeader("access-control-allow-methods", "GET,PUT,HEAD,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,range,x-prime-expires-at,x-prime-expiration-seconds"
  );
  response.setHeader("access-control-expose-headers", "content-range,etag,x-prime-blob-id,x-prime-name-hash,x-prime-expires-at,x-prime-recovered,x-prime-missing-shards");
  response.setHeader("access-control-max-age", "600");
}

async function handleDeveloperRequest({
  request,
  response,
  requestUrl,
  providers,
  registry,
  erasureEngine,
  objectStore,
  authManager,
  publicBaseUrl
}) {
  if (!requestUrl.pathname.startsWith(DEVELOPER_API_PREFIX)) return false;
  if (!objectStore) throw new GatewayError(503, "developer API object store is not configured");

  if (request.method === "GET" && requestUrl.pathname === DEVELOPER_API_PREFIX) {
    json(response, 200, {
      service: "Prime Server",
      apiVersion: "1",
      network: "flare-coston2",
      authentication: "wallet-signature-session",
      maxBlobBytes: MAX_BODY_BYTES,
      capabilities: {
        blobPut: true,
        blobGet: true,
        blobHead: true,
        blobList: true,
        rangeReads: true,
        chainOwnedNames: true,
        multipartUploads: false,
        s3Gateway: false,
        payments: false
      }
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === `${DEVELOPER_API_PREFIX}/auth/challenge`) {
    if (!authManager) throw new GatewayError(503, "developer API authentication is not configured");
    json(response, 200, authManager.createChallenge(requestUrl.searchParams.get("address")));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === `${DEVELOPER_API_PREFIX}/auth/session`) {
    if (!authManager) throw new GatewayError(503, "developer API authentication is not configured");
    json(response, 200, await authManager.createSession(await readJsonBody(request)));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === `${DEVELOPER_API_PREFIX}/account`) {
    const session = requireSession(request, authManager);
    json(response, 200, { address: session.address, expiresAt: new Date(session.expiresAt).toISOString() });
    return true;
  }

  const blobPath = parseDeveloperBlobPath(requestUrl.pathname);
  if (!blobPath) {
    json(response, 404, { error: "route not found" });
    return true;
  }

  const { account, name } = blobPath;
  const session = requireSession(request, authManager);
  requireAccountOwner(session, account);

  if (name === null) {
    if (request.method !== "GET") throw new GatewayError(405, "method not allowed");
    const listing = await objectStore.listObjects(account, {
      prefix: requestUrl.searchParams.get("prefix") || "",
      limit: requestUrl.searchParams.get("limit") || 100,
      cursor: requestUrl.searchParams.get("cursor") || ""
    });
    json(response, 200, {
      account,
      objects: listing.objects
        .filter((object) => object.expiresAt > Math.floor(Date.now() / 1000))
        .map((object) => objectResponse(object, requestUrl, publicBaseUrl)),
      nextCursor: listing.nextCursor
    });
    return true;
  }

  const object = await objectStore.getObject(account, name);
  if (object && object.expiresAt <= Math.floor(Date.now() / 1000)) throw new GatewayError(410, "blob has expired");

  if (request.method === "PUT") {
    if (object) throw new GatewayError(409, "blob name already exists");
    const expiresAt = parseExpiration(request);
    const input = await readRequestBody(request);
    const result = await uploadBlob({
      input,
      providers,
      registry,
      erasureEngine,
      owner: account,
      blobName: name,
      expiresAt
    });
    const stored = await objectStore.putObject({
      account,
      name,
      blobId: result.blobId,
      size: result.size,
      contentType: request.headers["content-type"] || "application/octet-stream",
      commitment: result.commitment,
      nameHash: result.nameHash,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: result.status
    });
    const responseObject = objectResponse(stored, requestUrl, publicBaseUrl);
    response.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      location: `${requestUrl.origin}${DEVELOPER_API_PREFIX}/blobs/${account}/${encodeURIComponent(name)}`,
      etag: `"${stored.commitment}"`
    });
    response.end(`${JSON.stringify(responseObject)}\n`);
    return true;
  }

  if (!object) throw new GatewayError(404, "blob not found");
  if (request.method === "HEAD") {
    response.writeHead(200, objectHeaders(object));
    response.end();
    return true;
  }
  if (request.method !== "GET") throw new GatewayError(405, "method not allowed");

  const result = await readBlob({ blobId: object.blobId, providers, registry, erasureEngine });
  const range = parseRange(request.headers.range, result.bytes.length);
  if (range?.invalid) {
    json(response, 416, { error: "range not satisfiable" }, { "content-range": `bytes */${result.bytes.length}` });
    return true;
  }
  const start = range?.start || 0;
  const end = range?.end ?? result.bytes.length - 1;
  const body = result.bytes.subarray(start, end + 1);
  const headers = {
    ...objectHeaders(object),
    "content-length": body.length,
    "x-prime-recovered": String(result.recovered),
    "x-prime-missing-shards": result.missingShards.join( ",")
  };
  if (range) {
    headers["content-range"] = `bytes ${start}-${end}/${result.bytes.length}`;
    response.writeHead(206, headers);
  } else {
    response.writeHead(200, headers);
  }
  response.end(body);
  return true;
}

async function providerHealth(provider) {
  const response = await fetch(`${provider.url}/health`);
  if (!response.ok) throw new Error(`provider ${provider.providerId} health failed`);
  return response.json();
}

async function uploadShard(provider, blobId, shardIndex, bytes, commitment) {
  const response = await fetch(`${provider.url}/v1/shards/${blobId}/${shardIndex}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-prime-shard-commitment": commitment
    },
    body: bytes
  });
  const receipt = await response.json();
  if (!response.ok) throw new Error(`provider ${provider.providerId} rejected shard: ${receipt.error || response.status}`);
  return receipt;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > requestedEnd || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function readProviderShard(provider, blobId, shardIndex, expectedCommitment, expectedSize) {
  const response = await fetch(`${provider.url}/v1/shards/${blobId}/${shardIndex}`);
  if (!response.ok) throw new Error(`provider ${provider.providerId} returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualCommitment = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== expectedSize) throw new Error(`provider ${provider.providerId} returned the wrong shard size`);
  if (actualCommitment !== expectedCommitment) throw new Error(`provider ${provider.providerId} returned a corrupt shard`);
  return bytes;
}

export async function readBlob({ blobId, providers, registry, erasureEngine }) {
  const blob = await registry.getBlob(blobId);
  if (!blob) throw new Error("blob not found");
  const acknowledgements = new Map(blob.acknowledgements.map((acknowledgement) => [acknowledgement.shardIndex, acknowledgement]));
  const available = [];
  const missing = [];

  for (let shardIndex = 0; shardIndex < blob.totalShards; shardIndex += 1) {
    const providerId = blob.placement[String(shardIndex)] ?? blob.placement[shardIndex];
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    const acknowledgement = acknowledgements.get(shardIndex);
    if (!provider || !acknowledgement) {
      missing.push(shardIndex);
      continue;
    }
    try {
      const bytes = await readProviderShard(provider, blobId, shardIndex, acknowledgement.commitment, acknowledgement.size);
      available.push({ index: shardIndex, bytes });
    } catch {
      missing.push(shardIndex);
    }
  }

  if (available.length < blob.dataShards) {
    throw new Error(`not enough healthy shards for recovery: ${available.length}/${blob.dataShards}`);
  }

  let recovered;
  const recoveredShards = {};
  if (missing.length === 0) {
    recovered = Buffer.concat(
      available.filter(({ index }) => index < blob.dataShards).sort((a, b) => a.index - b.index).map(({ bytes }) => bytes)
    ).subarray(0, blob.size);
  } else {
    const decoded = await erasureEngine.decode(available, missing, blob.size);
    recovered = decoded.recovered;
    for (const shardIndex of missing) recoveredShards[shardIndex] = decoded.chunks[shardIndex];
  }

  return {
    blob,
    bytes: recovered,
    missingShards: missing,
    recovered: missing.length > 0,
    recoveredShards,
    contentHash: createHash("sha256").update(recovered).digest("hex")
  };
}

export async function rebuildBlob({ blobId, providers, registry, erasureEngine }) {
  const result = await readBlob({ blobId, providers, registry, erasureEngine });
  if (result.missingShards.length === 0) {
    return { blobId, rebuiltShards: [], status: result.blob.status, contentHash: result.contentHash };
  }

  const rebuiltShards = [];
  for (const shardIndex of result.missingShards) {
    const providerId = result.blob.placement[String(shardIndex)] ?? result.blob.placement[shardIndex];
    const provider = providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) throw new Error(`provider ${providerId} is required for shard rebuild`);
    const bytes = Buffer.from(result.recoveredShards[shardIndex]);
    const commitment = createHash("sha256").update(bytes).digest("hex");

    await registry.startRecovery(blobId, shardIndex);
    await registry.reassignShard(blobId, shardIndex, provider.providerId);
    const receipt = await uploadShard(provider, blobId, shardIndex, bytes, commitment);
    await registry.acknowledgeShard({
      blobId,
      shardIndex,
      providerId: provider.providerId,
      commitment: receipt.commitment,
      size: receipt.size,
      signedPayload: receipt.signedPayload,
      signature: receipt.signature
    });
    await registry.recordRebuiltShard({ blobId, shardIndex, providerId: provider.providerId, commitment: receipt.commitment });
    rebuiltShards.push({ shardIndex, providerId: provider.providerId, commitment: receipt.commitment });
  }

  const final = await readBlob({ blobId, providers, registry, erasureEngine });
  if (final.missingShards.length !== 0) throw new Error("rebuilt blob is still missing shards");
  return { blobId, rebuiltShards, status: final.blob.status, contentHash: final.contentHash };
}

export async function uploadBlob({ input, providers, registry, erasureEngine, owner = "local-owner", blobName = "", expiresAt = 0 }) {
  if (providers.length !== FOUR_PROVIDER_CONFIG.n) throw new Error("the first upload path requires four providers");
  const encoded = erasureEngine.encode(input);
  const blobId = createHash("sha256").update(input).update(randomBytes(16)).digest("hex");

  const blobArguments = {
    blobId,
    owner,
    commitment: encoded.clayChunksetRoot,
    size: input.length,
    chunkSize: erasureEngine.config.chunkSizeBytes,
    dataShards: erasureEngine.config.k,
    totalShards: erasureEngine.config.n,
    expiresAt
  };
  const nameHash = blobName ? keccak256(stringToHex(blobName)).slice(2) : "";
  if (/^0x[a-fA-F0-9]{40}$/.test(owner) && blobName && typeof registry.createBlobForNamed === "function") {
    await registry.createBlobForNamed({ ...blobArguments, blobName });
  } else if (/^0x[a-fA-F0-9]{40}$/.test(owner) && blobName) {
    throw new Error("registry named blob support is required for developer uploads");
  } else if (/^0x[a-fA-F0-9]{40}$/.test(owner) && typeof registry.createBlobFor === "function") {
    await registry.createBlobFor(blobArguments);
  } else {
    await registry.createBlob(blobArguments);
  }

  const receipts = [];
  for (let shardIndex = 0; shardIndex < encoded.chunks.length; shardIndex += 1) {
    const provider = providers[shardIndex];
    await registry.assignShard(blobId, shardIndex, provider.providerId);
    const receipt = await uploadShard(
      provider,
      blobId,
      shardIndex,
      encoded.chunks[shardIndex],
      encoded.chunkCommitments[shardIndex]
    );
    await registry.acknowledgeShard({
      blobId,
      shardIndex,
      providerId: provider.providerId,
      commitment: receipt.commitment,
      size: receipt.size,
      signedPayload: receipt.signedPayload,
      signature: receipt.signature
    });
    receipts.push({
      providerId: provider.providerId,
      shardIndex,
      commitment: receipt.commitment,
      size: receipt.size
    });
  }

  await registry.finalizeBlob(blobId);
  const registryState = await registry.getBlob(blobId);
  return {
    blobId,
    commitment: encoded.clayChunksetRoot,
    nameHash,
    chunkCommitments: encoded.chunkCommitments,
    clayChunkRoots: encoded.clayChunkRoots,
    size: input.length,
    status: registryState?.status || "active",
    providers: receipts,
    registry: registryState
  };
}

export async function createPrimeRpcServer({
  providers,
  registry,
  erasureEngine,
  recoveryCoordinator,
  objectStore,
  authManager,
  publicBaseUrl = "",
  corsOrigin = "*"
} = {}) {
  if (!providers?.length) throw new Error("providers are required");
  if (!registry) throw new Error("registry is required");
  const engine = erasureEngine || await createErasureEngine(FOUR_PROVIDER_CONFIG);

  for (const provider of providers) {
    const health = await providerHealth(provider);
    await registry.registerProvider({
      providerId: provider.providerId,
      endpoint: provider.url,
      publicKey: health.identity.publicKey
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith(DEVELOPER_API_PREFIX)) {
        applyCorsHeaders(res, corsOrigin);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        await handleDeveloperRequest({
          request: req,
          response: res,
          requestUrl,
          providers,
          registry,
          erasureEngine: engine,
          objectStore,
          authManager,
          publicBaseUrl
        });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        json(res, 200, { status: "ok", providerCount: providers.length });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/v1/recovery") {
        if (!recoveryCoordinator) {
          json(res, 200, { jobs: [] });
          return;
        }
        json(res, 200, { jobs: await recoveryCoordinator.listJobs() });
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/v1/blobs") {
        const input = await readRequestBody(req);
        const result = await uploadBlob({ input, providers, registry, erasureEngine: engine });
        json(res, 201, result);
        return;
      }
      const recoveryMatch = requestUrl.pathname.match(/^\/v1\/blobs\/([A-Za-z0-9._-]+)\/recover$/);
      if (req.method === "POST" && recoveryMatch) {
        const result = recoveryCoordinator
          ? await recoveryCoordinator.recoverBlob({ blobId: recoveryMatch[1], reason: "api_request" })
          : await rebuildBlob({ blobId: recoveryMatch[1], providers, registry, erasureEngine: engine });
        json(res, 200, result);
        return;
      }
      const blobMatch = requestUrl.pathname.match(/^\/v1\/blobs\/([A-Za-z0-9._-]+)$/);
      if (req.method === "GET" && blobMatch) {
        const blob = await registry.getBlob(blobMatch[1]);
        if (!blob) {
          json(res, 404, { error: "blob not found" });
          return;
        }
        json(res, 200, blob);
        return;
      }
      const contentMatch = requestUrl.pathname.match(/^\/v1\/blobs\/([A-Za-z0-9._-]+)\/content$/);
      if (req.method === "GET" && contentMatch) {
        const result = await readBlob({ blobId: contentMatch[1], providers, registry, erasureEngine: engine });
        const range = parseRange(req.headers.range, result.bytes.length);
        if (range?.invalid) {
          json(res, 416, { error: "range not satisfiable" }, { "content-range": `bytes */${result.bytes.length}` });
          return;
        }
        const start = range?.start || 0;
        const end = range?.end ?? result.bytes.length - 1;
        const body = result.bytes.subarray(start, end + 1);
        const headers = {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          "accept-ranges": "bytes",
          "x-prime-blob-id": result.blob.blobId,
          "x-prime-content-hash": result.contentHash,
          "x-prime-recovered": String(result.recovered),
          "x-prime-missing-shards": result.missingShards.join(",")
        };
        if (range) {
          headers["content-range"] = `bytes ${start}-${end}/${result.bytes.length}`;
          res.writeHead(206, headers);
        } else {
          res.writeHead(200, headers);
        }
        res.end(body);
        return;
      }
      json(res, 404, { error: "route not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      const statusCode = error?.statusCode || (/already exists/.test(message) ? 409 : /required|larger|requires four|mismatch|invalid/.test(message) ? 400 : 502);
      json(res, statusCode, { error: message }, error?.headers || {});
    }
  });

  return { server, erasureEngine: engine, providers, registry };
}
