import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createErasureEngine, FOUR_PROVIDER_CONFIG } from "../../provider/src/erasure.mjs";

const MAX_BODY_BYTES = FOUR_PROVIDER_CONFIG.k * FOUR_PROVIDER_CONFIG.chunkSizeBytes;

function json(res, statusCode, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length
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
  return {
    blobId,
    commitment: encoded.clayChunksetRoot,
    chunkCommitments: encoded.chunkCommitments,
    clayChunkRoots: encoded.clayChunkRoots,
    size: input.length,
    status: registry.getBlob(blobId)?.status || "active",
    providers: receipts,
    registry: registry.getBlob(blobId)
  };
}

export async function createPrimeRpcServer({ providers, registry, erasureEngine } = {}) {
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
      if (req.method === "POST" && requestUrl.pathname === "/v1/blobs") {
        const input = await readRequestBody(req);
        const result = await uploadBlob({ input, providers, registry, erasureEngine: engine });
        json(res, 201, result);
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

