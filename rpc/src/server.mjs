import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createErasureEngine, FOUR_PROVIDER_CONFIG } from "../../provider/src/erasure.mjs";

const MAX_BODY_BYTES = FOUR_PROVIDER_CONFIG.k * FOUR_PROVIDER_CONFIG.chunkSizeBytes;

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

export async function uploadBlob({ input, providers, registry, erasureEngine, owner = "local-owner" }) {
  if (providers.length !== FOUR_PROVIDER_CONFIG.n) throw new Error("the first upload path requires four providers");
  const encoded = erasureEngine.encode(input);
  const blobId = createHash("sha256").update(input).update(randomBytes(16)).digest("hex");

  await registry.createBlob({
    blobId,
    owner,
    commitment: encoded.clayChunksetRoot,
    size: input.length,
    chunkSize: erasureEngine.config.chunkSizeBytes,
    dataShards: erasureEngine.config.k,
    totalShards: erasureEngine.config.n
  });

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
    chunkCommitments: encoded.chunkCommitments,
    clayChunkRoots: encoded.clayChunkRoots,
    size: input.length,
    status: registryState?.status || "active",
    providers: receipts,
    registry: registryState
  };
}

export async function createPrimeRpcServer({ providers, registry, erasureEngine, recoveryCoordinator } = {}) {
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
      const statusCode = /required|larger|requires four|mismatch|invalid/.test(message) ? 400 : 502;
      json(res, statusCode, { error: message });
    }
  });

  return { server, erasureEngine: engine, providers, registry };
}
