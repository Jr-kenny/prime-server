import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createErasureEngine, FOUR_PROVIDER_CONFIG } from "../../provider/src/erasure.mjs";
import { getAddress, isAddress, keccak256, stringToHex } from "viem";
import { bearerToken } from "./auth.mjs";
import { acknowledgementContext as buildAcknowledgementContext } from "./ack-context.mjs";

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
  const payload = Buffer.from(`${JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
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

async function requireSelectedWalletCiphertextAccess({ request, session, account, object, registry }) {
  if (session.address.toLowerCase() === account.toLowerCase()) return;
  if (!object || ![1, "1", "selected_wallets"].includes(object.accessPolicy)) {
    throw new GatewayError(403, "wallet is not authorized to retrieve this ciphertext");
  }
  const requestId = normalizeHex(request.headers["x-prime-access-request-id"]);
  if (!/^[a-f0-9]{64}$/.test(requestId)) {
    throw new GatewayError(403, "an active selected-wallet access request is required");
  }
  if (typeof registry.getConfidentialAccessRequest !== "function" || typeof registry.isConfidentialAccessUsable !== "function") {
    throw new GatewayError(503, "selected-wallet ciphertext retrieval is not configured");
  }
  const access = await registry.getConfidentialAccessRequest(requestId);
  if (!access?.exists || access.consumed || access.purpose !== 0) {
    throw new GatewayError(403, "access request cannot retrieve ciphertext");
  }
  if (String(access.requester).toLowerCase() !== session.address.toLowerCase()) {
    throw new GatewayError(403, "access request requester does not match the session wallet");
  }
  if (normalizeHex(access.blobId) !== normalizeHex(object.blobId)) {
    throw new GatewayError(403, "access request does not match the blob");
  }
  if (!(await registry.isConfidentialAccessUsable(requestId))) {
    throw new GatewayError(403, "access request is no longer usable");
  }
}

function parseHeaderInteger(request, name, { required = false } = {}) {
  const value = request.headers[name];
  if (value === undefined) {
    if (required) throw new GatewayError(400, `${name} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GatewayError(400, `${name} must be a non-negative integer`);
  return parsed;
}

function parseHeaderEnum(request, name, names, { required = false } = {}) {
  const value = request.headers[name];
  if (value === undefined) {
    if (required) throw new GatewayError(400, `${name} is required`);
    return null;
  }
  const normalized = String(value).toLowerCase().replace(/-/g, "_");
  const named = names.indexOf(normalized);
  if (named !== -1) return named;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= names.length) throw new GatewayError(400, `${name} must be a supported value`);
  return parsed;
}

function normalizeHex(value) {
  return String(value || "").replace(/^0x/, "").toLowerCase();
}

function requireBlobIdHeader(request) {
  const blobId = normalizeHex(request.headers["x-prime-blob-id"]);
  if (!/^[a-f0-9]{64}$/.test(blobId)) throw new GatewayError(400, "x-prime-blob-id must be a 32-byte hex identifier");
  return blobId;
}

function assertRegistrationMatchesRequest({ registration, blobId, account, name, request }) {
  if (!registration || registration.blobId?.toLowerCase() !== blobId) throw new GatewayError(404, "registered blob not found");
  if (registration.origin !== "user") throw new GatewayError(403, "public uploads require a user-registered blob");
  if (String(registration.owner).toLowerCase() !== account.toLowerCase()) throw new GatewayError(403, "registered blob owner does not match the account");
  if (registration.blobName !== name) throw new GatewayError(409, "registered blob name does not match the request");
  if (registration.nameHash && normalizeHex(registration.nameHash) !== normalizeHex(keccak256(stringToHex(name)))) {
    throw new GatewayError(409, "registered blob name hash does not match the request");
  }
  if (registration.status !== "pending") throw new GatewayError(409, "registered blob is no longer pending");
  if (registration.expiresAt > 0 && registration.expiresAt <= Math.floor(Date.now() / 1000)) throw new GatewayError(410, "registered blob has expired");

  const contentLength = parseHeaderInteger(request, "content-length", { required: true });
  if (contentLength !== registration.size) throw new GatewayError(400, "content-length does not match the registered blob size");

  const claimedCommitment = request.headers["x-prime-commitment"];
  if (claimedCommitment !== undefined && normalizeHex(claimedCommitment) !== normalizeHex(registration.commitment)) {
    throw new GatewayError(400, "x-prime-commitment does not match the registered commitment");
  }
  const claimedExpiry = parseHeaderInteger(request, "x-prime-expires-at");
  if (claimedExpiry !== null && claimedExpiry !== registration.expiresAt) throw new GatewayError(400, "x-prime-expires-at does not match the registered expiry");
  if (request.headers["x-prime-expiration-seconds"] !== undefined) throw new GatewayError(400, "expiration must be registered on Flare before upload");
  const claims = [
    ["x-prime-chunk-size", registration.chunkSize],
    ["x-prime-data-shards", registration.dataShards],
    ["x-prime-total-shards", registration.totalShards]
  ];
  for (const [header, expected] of claims) {
    const claimed = parseHeaderInteger(request, header);
    if (claimed !== null && claimed !== expected) throw new GatewayError(400, `${header} does not match the registered encoding`);
  }

  const paymentStatus = registration.payment?.statusName;
  if (paymentStatus && paymentStatus !== "none") {
    if (paymentStatus !== "escrowed") throw new GatewayError(409, "paid blob registration is not awaiting upload");
    const policy = registration.policy;
    if (!policy || policy.storageModeName === "unknown") throw new GatewayError(502, "paid blob policy is unavailable from the registry");
    const storageMode = parseHeaderEnum(request, "x-prime-storage-mode", ["public", "private", "confidential"], { required: true });
    const accessPolicy = parseHeaderEnum(request, "x-prime-access-policy", ["owner_only", "selected_wallets", "compute_only"], { required: true });
    if (storageMode !== policy.storageMode) throw new GatewayError(400, "x-prime-storage-mode does not match the registered policy");
    if (accessPolicy !== policy.accessPolicy) throw new GatewayError(400, "x-prime-access-policy does not match the registered policy");
    const policyClaims = [
      ["x-prime-policy-commitment", policy.policyCommitment],
      ["x-prime-key-envelope-commitment", policy.keyEnvelopeCommitment],
      ["x-prime-metadata-commitment", policy.metadataCommitment]
    ];
    for (const [header, expected] of policyClaims) {
      const claimed = request.headers[header];
      if (claimed === undefined) throw new GatewayError(400, `${header} is required for paid uploads`);
      if (normalizeHex(claimed) !== normalizeHex(expected)) throw new GatewayError(400, `${header} does not match the registered policy`);
    }
  }
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
    origin: object.origin,
    storageMode: object.storageMode,
    accessPolicy: object.accessPolicy,
    policyCommitment: object.policyCommitment,
    keyEnvelopeCommitment: object.keyEnvelopeCommitment,
    metadataCommitment: object.metadataCommitment,
    paymentStatus: object.paymentStatus,
    paymentAsset: object.paymentAsset,
    providerSettlements: object.providerSettlements,
    downloadUrl: `${apiBase}/blobs/${object.account}/${encodeURIComponent(object.name)}`
  };
}

function objectHeaders(object) {
  const headers = {
    "content-type": object.contentType || "application/octet-stream",
    "content-length": object.size,
    etag: `"${object.commitment}"`,
    "x-prime-blob-id": object.blobId,
    "x-prime-name-hash": object.nameHash || "",
    "x-prime-expires-at": String(object.expiresAt),
    "accept-ranges": "bytes"
  };
  if (object.storageMode !== undefined) headers["x-prime-storage-mode"] = String(object.storageMode);
  if (object.accessPolicy !== undefined) headers["x-prime-access-policy"] = String(object.accessPolicy);
  if (object.policyCommitment) headers["x-prime-policy-commitment"] = object.policyCommitment;
  if (object.paymentStatus) headers["x-prime-payment-status"] = object.paymentStatus;
  return headers;
}

function isComputeOnly(object) {
  return object?.accessPolicy === 2 || object?.accessPolicy === "2" || object?.accessPolicy === "compute_only";
}

function applyCorsHeaders(response, origin) {
  response.setHeader("access-control-allow-origin", origin || "*");
  response.setHeader("access-control-allow-methods", "GET,PUT,HEAD,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,range,x-prime-blob-id,x-prime-commitment,x-prime-chunk-size,x-prime-data-shards,x-prime-total-shards,x-prime-expires-at,x-prime-storage-mode,x-prime-access-policy,x-prime-policy-commitment,x-prime-key-envelope-commitment,x-prime-metadata-commitment,x-prime-access-request-id"
  );
  response.setHeader("access-control-expose-headers", "content-range,etag,x-prime-blob-id,x-prime-name-hash,x-prime-expires-at,x-prime-recovered,x-prime-missing-shards,x-prime-storage-mode,x-prime-access-policy,x-prime-policy-commitment,x-prime-payment-status");
  response.setHeader("access-control-max-age", "600");
}

function normalizeFccProxyUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

async function handleFccProxyRequest({ request, response, requestUrl, authManager, fccProxyUrl }) {
  const prefix = `${DEVELOPER_API_PREFIX}/fcc`;
  if (!requestUrl.pathname.startsWith(`${prefix}/`)) return false;
  if (request.method !== "GET") throw new GatewayError(405, "method not allowed");
  requireSession(request, authManager);
  const proxyUrl = normalizeFccProxyUrl(fccProxyUrl);
  if (!proxyUrl) throw new GatewayError(503, "FCC proxy is not configured");

  if (requestUrl.pathname === `${prefix}/info`) {
    const upstream = await fetch(`${proxyUrl}/info`);
    if (!upstream.ok) throw new GatewayError(502, `FCC proxy info returned ${upstream.status}`);
    json(response, 200, await upstream.json());
    return true;
  }

  const resultMatch = requestUrl.pathname.match(new RegExp(`^${prefix.replaceAll("/", "\\/")}/result/(0x)?([a-fA-F0-9]{64})$`));
  if (resultMatch) {
    const instructionId = `0x${resultMatch[2]}`;
    const upstream = await fetch(`${proxyUrl}/action/result/${instructionId}`);
    if (upstream.status === 404 || upstream.status === 202) {
      json(response, 202, { status: "pending", instructionId });
      return true;
    }
    if (!upstream.ok) throw new GatewayError(502, `FCC proxy result returned ${upstream.status}`);
    json(response, 200, await upstream.json());
    return true;
  }

  json(response, 404, { error: "FCC route not found" });
  return true;
}

async function handleFccInternalRequest({ request, response, requestUrl, registry, providers, erasureEngine, fccInternalToken }) {
  const prefix = "/internal/fcc/blobs/";
  if (!requestUrl.pathname.startsWith(prefix)) return false;
  if (request.method !== "GET") throw new GatewayError(405, "method not allowed");
  if (!fccInternalToken) throw new GatewayError(404, "FCC internal storage route is not configured");
  if (String(request.headers["x-prime-fcc-token"] || "") !== fccInternalToken) {
    throw new GatewayError(401, "FCC internal storage authorization failed");
  }

  const match = requestUrl.pathname.match(/^\/internal\/fcc\/blobs\/(0x)?([a-fA-F0-9]{64})\/ciphertext$/);
  if (!match) {
    json(response, 404, { error: "FCC internal route not found" });
    return true;
  }
  const blobId = `0x${match[2]}`;
  const blob = await registry.getBlob(blobId);
  if (!blob) throw new GatewayError(404, "blob not found");
  if (blob.policy?.storageMode !== 2 && blob.policy?.storageModeName !== "confidential") {
    throw new GatewayError(403, "FCC ciphertext route requires confidential storage");
  }
  if (blob.policy?.accessPolicy !== 2 && blob.policy?.accessPolicyName !== "compute_only") {
    throw new GatewayError(403, "FCC ciphertext route requires compute-only access");
  }
  const result = await readBlob({ blobId, providers, registry, erasureEngine });
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": result.bytes.length,
    etag: `"${result.contentHash}"`,
    "x-prime-blob-id": blobId,
    "x-prime-recovered": String(result.recovered),
    "x-prime-missing-shards": result.missingShards.join(",")
  });
  response.end(result.bytes);
  return true;
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
  publicBaseUrl,
  fccProxyUrl,
  fccComputeEnabled
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
        registrationRequired: true,
        ownershipSource: "flare-registry",
        clientPreparation: true,
        multipartUploads: false,
        s3Gateway: false,
        payments: typeof registry.quoteNativePayment === "function",
        paymentAssets: typeof registry.quoteNativePayment === "function" ? ["native_flare"] : [],
        atomicNativeRegistration: typeof registry.createBlobNamedPaid === "function",
        crossChainPayments: false,
        encryptedStorage: typeof registry.getBlobPolicy === "function",
        confidentialAccessAuthorization: typeof registry.authorizeConfidentialAccess === "function",
        confidentialCompute: Boolean(fccComputeEnabled)
      }
    });
    return true;
  }

  if (requestUrl.pathname.startsWith(`${DEVELOPER_API_PREFIX}/fcc/`)) {
    return handleFccProxyRequest({ request, response, requestUrl, authManager, fccProxyUrl });
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

  if (name === null) {
    requireAccountOwner(session, account);
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
    requireAccountOwner(session, account);
    if (object) throw new GatewayError(409, "blob name already exists");
    const blobId = requireBlobIdHeader(request);
    const registration = await registry.getBlob(blobId);
    assertRegistrationMatchesRequest({ registration, blobId, account, name, request });
    const input = await readRequestBody(request);
    const result = await uploadRegisteredBlob({
      input,
      blobId,
      blobName: name,
      account,
      registration,
      providers,
      registry,
      erasureEngine,
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
      expiresAt: result.registry.expiresAt,
      status: result.status,
      origin: result.registry.origin,
      storageMode: result.registry.policy?.storageModeName,
      accessPolicy: result.registry.policy?.accessPolicyName,
      policyCommitment: result.registry.policy?.policyCommitment,
      keyEnvelopeCommitment: result.registry.policy?.keyEnvelopeCommitment,
      metadataCommitment: result.registry.policy?.metadataCommitment,
      paymentStatus: result.registry.payment?.statusName,
      paymentAsset: result.registry.payment?.assetName,
      providerSettlements: result.providerSettlements
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
  await requireSelectedWalletCiphertextAccess({ request, session, account, object, registry });
  if (request.method === "HEAD") {
    response.writeHead(200, objectHeaders(object));
    response.end();
    return true;
  }
  if (request.method !== "GET") throw new GatewayError(405, "method not allowed");
  if (isComputeOnly(object)) throw new GatewayError(403, "compute-only blobs require an FCC access result");

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

function acknowledgementContext({ registry, blob, blobId, providerId, shardIndex, commitment, size }) {
  return buildAcknowledgementContext({
    chainId: registry.chainId ?? registry.chain?.id ?? "unknown",
    registryAddress: registry.address ?? "memory-registry",
    blobId,
    owner: blob.owner,
    nameHash: blob.nameHash,
    providerId,
    shardIndex,
    commitment,
    size
  });
}

async function uploadShard(provider, blobId, shardIndex, bytes, commitment, ackContext = "") {
  const headers = {
    "content-type": "application/octet-stream",
    "x-prime-shard-commitment": commitment
  };
  if (ackContext) headers["x-prime-ack-context"] = ackContext;
  const response = await fetch(`${provider.url}/v1/shards/${blobId}/${shardIndex}`, {
    method: "PUT",
    headers,
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
    const ackContext = acknowledgementContext({
      registry,
      blob: result.blob,
      blobId,
      providerId: provider.providerId,
      shardIndex,
      commitment,
      size: bytes.length
    });

    await registry.startRecovery(blobId, shardIndex);
    await registry.reassignShard(blobId, shardIndex, provider.providerId);
    const receipt = await uploadShard(provider, blobId, shardIndex, bytes, commitment, ackContext);
    await registry.acknowledgeShard({
      blobId,
      shardIndex,
      providerId: provider.providerId,
      commitment: receipt.commitment,
      size: receipt.size,
      ackContext,
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

async function placeEncodedBlob({ input, encoded, blobId, providers, registry }) {
  if (providers.length !== FOUR_PROVIDER_CONFIG.n) throw new Error("the first upload path requires four providers");
  const blob = await registry.getBlob(blobId);
  if (!blob) throw new Error("blob registration not found");

  const receipts = [];
  for (let shardIndex = 0; shardIndex < encoded.chunks.length; shardIndex += 1) {
    const placedProviderId = blob.placement[String(shardIndex)] ?? blob.placement[shardIndex];
    const hasExistingProvider = placedProviderId !== undefined && placedProviderId !== null && String(placedProviderId) !== "0";
    const provider = hasExistingProvider
      ? providers.find((candidate) => String(candidate.providerId) === String(placedProviderId))
      : providers[shardIndex];
    if (!provider) throw new Error(`assigned provider ${placedProviderId} is unavailable for shard ${shardIndex}`);
    if (!hasExistingProvider) await registry.assignShard(blobId, shardIndex, provider.providerId);
    const ackContext = acknowledgementContext({
      registry,
      blob,
      blobId,
      providerId: provider.providerId,
      shardIndex,
      commitment: encoded.chunkCommitments[shardIndex],
      size: encoded.chunks[shardIndex].length
    });
    const receipt = await uploadShard(
      provider,
      blobId,
      shardIndex,
      encoded.chunks[shardIndex],
      encoded.chunkCommitments[shardIndex],
      ackContext
    );
    const existingAcknowledgement = blob.acknowledgements.find((acknowledgement) =>
      Number(acknowledgement.shardIndex) === shardIndex
      && String(acknowledgement.providerId) === String(provider.providerId)
    );
    if (existingAcknowledgement) {
      if (normalizeHex(existingAcknowledgement.commitment) !== normalizeHex(receipt.commitment) || Number(existingAcknowledgement.size) !== Number(receipt.size)) {
        throw new Error(`existing acknowledgement does not match shard ${shardIndex}`);
      }
    } else {
      await registry.acknowledgeShard({
        blobId,
        shardIndex,
        providerId: provider.providerId,
        commitment: receipt.commitment,
        size: receipt.size,
        ackContext,
        signedPayload: receipt.signedPayload,
        signature: receipt.signature
      });
    }
    receipts.push({
      providerId: provider.providerId,
      shardIndex,
      commitment: receipt.commitment,
      size: receipt.size
    });
  }

  await registry.finalizeBlob(blobId);
  let registryState = await registry.getBlob(blobId);
  const providerSettlements = await settleProviderClaims({ blobId, registryState, providers, registry });
  if (providerSettlements.length > 0) registryState = await registry.getBlob(blobId);
  return {
    blobId,
    commitment: encoded.clayChunksetRoot,
    nameHash: registryState?.nameHash || blob.nameHash || "",
    chunkCommitments: encoded.chunkCommitments,
    clayChunkRoots: encoded.clayChunkRoots,
    size: input.length,
    status: registryState?.status || "active",
    providers: receipts,
    providerSettlements,
    registry: registryState
  };
}

async function settleProviderClaims({ blobId, registryState, providers, registry }) {
  if (typeof registry.getBlobPayment !== "function" || typeof registry.claimProviderSettlement !== "function") return [];
  const payment = registryState?.payment || await registry.getBlobPayment(blobId);
  if (!payment || !["claimable", "partially_settled"].includes(payment.statusName)) return [];

  const shardsByProvider = new Map();
  for (let shardIndex = 0; shardIndex < registryState.totalShards; shardIndex += 1) {
    const providerId = registryState.placement[String(shardIndex)] ?? registryState.placement[shardIndex];
    if (!providerId) continue;
    const shardIndices = shardsByProvider.get(String(providerId)) || [];
    shardIndices.push(shardIndex);
    shardsByProvider.set(String(providerId), shardIndices);
  }

  const settlements = [];
  for (const [providerId, shardIndices] of shardsByProvider) {
    const provider = providers.find((candidate) => String(candidate.providerId) === providerId);
    if (!provider) throw new Error(`provider ${providerId} is required for settlement`);
    const result = await registry.claimProviderSettlement({ blobId, providerId, shardIndices });
    const reward = payment.providerRewardPerShard === undefined ? null : BigInt(payment.providerRewardPerShard);
    settlements.push({
      providerId,
      shardIndices,
      transaction: result?.hash || null,
      amount: reward === null ? result?.amount?.toString?.() || null : (reward * BigInt(shardIndices.length)).toString()
    });
  }
  return settlements;
}

export async function uploadRegisteredBlob({ input, blobId, blobName, account, registration, providers, registry, erasureEngine }) {
  if (!registration) throw new Error("blob registration is required");
  if (normalizeHex(registration.blobId) !== normalizeHex(blobId)) throw new Error("registered blob ID does not match the request");
  if (registration.origin !== "user") throw new Error("public uploads require a user-registered blob");
  if (String(registration.owner).toLowerCase() !== String(account).toLowerCase()) throw new Error("registered blob owner does not match the account");
  if (registration.blobName !== blobName) throw new Error("registered blob name does not match the request");
  if (registration.nameHash && normalizeHex(registration.nameHash) !== normalizeHex(keccak256(stringToHex(blobName)))) throw new Error("registered blob name hash does not match the request");
  if (registration.status !== "pending") throw new Error("registered blob is no longer pending");
  if (registration.expiresAt > 0 && registration.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("registered blob has expired");
  if (registration.size !== input.length) throw new Error("input size does not match the registered blob");
  const encoded = erasureEngine.encode(input);
  if (normalizeHex(encoded.clayChunksetRoot) !== normalizeHex(registration.commitment)) {
    throw new Error("locally recomputed commitment does not match the registered commitment");
  }
  if (encoded.originalSize !== registration.size) throw new Error("encoded size does not match the registered blob");
  if (erasureEngine.config.chunkSizeBytes !== registration.chunkSize || erasureEngine.config.k !== registration.dataShards || erasureEngine.config.n !== registration.totalShards) {
    throw new Error("registered erasure parameters are not supported");
  }
  return placeEncodedBlob({ input, encoded, blobId, providers, registry });
}

export async function uploadBlob({ input, providers, registry, erasureEngine, blobName = "", expiresAt = 0 }) {
  const encoded = erasureEngine.encode(input);
  const blobId = createHash("sha256").update(input).update(randomBytes(16)).digest("hex");
  const blobArguments = {
    blobId,
    commitment: encoded.clayChunksetRoot,
    size: input.length,
    chunkSize: erasureEngine.config.chunkSizeBytes,
    dataShards: erasureEngine.config.k,
    totalShards: erasureEngine.config.n,
    expiresAt
  };
  if (blobName) {
    if (typeof registry.createOperatorBlobNamed !== "function") throw new Error("operator named blob support is required");
    await registry.createOperatorBlobNamed({ ...blobArguments, blobName });
  } else {
    if (typeof registry.createOperatorBlob !== "function") throw new Error("operator blob support is required");
    await registry.createOperatorBlob(blobArguments);
  }
  return placeEncodedBlob({ input, encoded, blobId, providers, registry });
}

export async function createPrimeRpcServer({
  providers,
  registry,
  erasureEngine,
  recoveryCoordinator,
  objectStore,
  authManager,
  publicBaseUrl = "",
  corsOrigin = "*",
  fccProxyUrl = "",
  fccInternalToken = ""
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
      if (requestUrl.pathname.startsWith("/internal/fcc/")) {
        const handled = await handleFccInternalRequest({
          request: req,
          response: res,
          requestUrl,
          registry,
          providers,
          erasureEngine: engine,
          fccInternalToken
        });
        if (handled) return;
      }
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
          publicBaseUrl,
          fccProxyUrl,
          fccComputeEnabled: Boolean(fccProxyUrl && fccInternalToken)
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
        const blob = await registry.getBlob(contentMatch[1]);
        if (!blob) {
          json(res, 404, { error: "blob not found" });
          return;
        }
        if (blob.policy?.accessPolicyName === "compute_only" || blob.policy?.accessPolicy === 2) {
          throw new GatewayError(403, "compute-only blobs require an FCC access result");
        }
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
