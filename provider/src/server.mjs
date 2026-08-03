import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProviderIdentity } from "./identity.mjs";
import { ProviderStorage, ShardConflictError, shardCommitment } from "./storage.mjs";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function json(res, statusCode, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    ...headers
  });
  res.end(payload);
}

function parseShardPath(pathname) {
  const match = pathname.match(/^\/v1\/shards\/([^/]+)\/(\d+)$/);
  return match ? { blobId: decodeURIComponent(match[1]), shardIndex: Number(match[2]) } : null;
}

async function readRequestBody(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("request body too large");

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;

  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const endInclusive = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || start > endInclusive || start >= size) {
    return { invalid: true };
  }
  return { start, endInclusive: Math.min(endInclusive, size - 1) };
}

function acknowledgementPayload({ providerId, blobId, shardIndex, commitment, size }) {
  return `${providerId}:${blobId}:${shardIndex}:${commitment}:${size}`;
}

export async function createProviderServer({ providerId, dataDir, host = "127.0.0.1", port = 0 } = {}) {
  if (!providerId) throw new Error("providerId is required");
  if (!dataDir) throw new Error("dataDir is required");
  await mkdir(dataDir, { recursive: true });

  const storage = await new ProviderStorage(dataDir).init();
  const identity = await new ProviderIdentity(dataDir).load();

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}`);

    try {
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        json(res, 200, {
          status: "ok",
          providerId,
          identity: identity.describe(),
          timestamp: new Date().toISOString()
        });
        return;
      }

      const shardPath = parseShardPath(requestUrl.pathname);
      if (!shardPath) {
        json(res, 404, { error: "route not found" });
        return;
      }

      if (req.method === "PUT") {
        const bytes = await readRequestBody(req);
        const expectedCommitment = req.headers["x-prime-shard-commitment"];
        const metadata = await storage.putShard({
          ...shardPath,
          bytes,
          commitment: typeof expectedCommitment === "string" ? expectedCommitment : undefined
        });
        const payload = acknowledgementPayload({ providerId, ...shardPath, ...metadata });
        const signature = identity.signPayload(payload);
        json(res, 201, {
          providerId,
          ...metadata,
          signedPayload: payload,
          signature: signature.toString("base64"),
          publicKey: identity.describe().publicKey
        });
        return;
      }

      if (req.method === "GET") {
        const metadata = await storage.getShardMetadata(shardPath.blobId, shardPath.shardIndex);
        const range = parseRange(req.headers.range, metadata.size);
        if (range?.invalid) {
          json(res, 416, { error: "range not satisfiable" }, { "content-range": `bytes */${metadata.size}` });
          return;
        }

        const result = await storage.readShard(shardPath.blobId, shardPath.shardIndex, {
          start: range?.start || 0,
          endExclusive: range ? range.endInclusive + 1 : metadata.size
        });
        const statusCode = range ? 206 : 200;
        const headers = {
          "content-type": "application/octet-stream",
          "content-length": result.bytes.length,
          "accept-ranges": "bytes",
          etag: `"${metadata.commitment}"`,
          "x-prime-shard-commitment": metadata.commitment,
          "x-prime-provider-id": providerId
        };
        if (range) headers["content-range"] = `bytes ${result.start}-${result.endExclusive - 1}/${result.size}`;
        res.writeHead(statusCode, headers);
        res.end(result.bytes);
        return;
      }

      json(res, 405, { error: "method not allowed" }, { allow: "GET, PUT" });
    } catch (error) {
      if (error.code === "ENOENT") {
        json(res, 404, { error: "shard not found" });
        return;
      }
      if (error instanceof ShardConflictError) {
        json(res, 409, { error: error.message, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : "request failed";
      const statusCode = /too large|mismatch|invalid/.test(message) ? 400 : 500;
      json(res, statusCode, { error: message });
    }
  });

  return {
    server,
    storage,
    identity,
    providerId,
    host,
    port,
    address() {
      return server.address();
    }
  };
}

async function main() {
  const providerId = process.env.PRIME_SERVER_PROVIDER_ID || "provider-1";
  const port = Number(process.env.PRIME_SERVER_PROVIDER_PORT || 7101);
  const host = process.env.PRIME_SERVER_PROVIDER_HOST || "127.0.0.1";
  const dataDir = process.env.PRIME_SERVER_PROVIDER_DATA_DIR || path.resolve(".prime-server", "providers", providerId);
  const provider = await createProviderServer({ providerId, host, port, dataDir });
  provider.server.listen(port, host, () => {
    const address = provider.server.address();
    console.log(JSON.stringify({ event: "provider_started", providerId, address, dataDir, host }));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

export { acknowledgementPayload, parseRange, shardCommitment };
