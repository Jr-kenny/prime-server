import { createHash, randomBytes } from "node:crypto";
import { createEncoder } from "@shelby-protocol/clay-codes";

export const PRIME_BLOB_CONFIG = Object.freeze({
  n: 4,
  k: 2,
  d: 3,
  chunkSizeBytes: 1024 * 1024
});

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new Error("blob input must be a Buffer, Uint8Array, or ArrayBuffer");
}

function validateName(name) {
  if (typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 1024 || name.includes("\0") || name.startsWith("/") || name.endsWith("/")) {
    throw new Error("blob name must be between 1 and 1024 bytes and cannot end with a slash");
  }
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeInput(input, encoder) {
  const bytes = asBuffer(input);
  const capacity = PRIME_BLOB_CONFIG.k * PRIME_BLOB_CONFIG.chunkSizeBytes;
  if (bytes.length === 0) throw new Error("blob body is required");
  if (bytes.length > capacity) throw new Error(`blob is larger than the first chunkset capacity of ${capacity} bytes`);

  const padded = Buffer.alloc(capacity);
  bytes.copy(padded);
  const collection = encoder.erasureCode(padded);
  const chunks = collection.chunks.map((chunk) => Buffer.from(chunk));
  const chunkCommitments = chunks.map(sha256);
  const chunksetCommitment = sha256(Buffer.from(chunkCommitments.join(""), "hex"));
  const clay = encoder.getMerkleCommitment();
  return {
    bytes,
    size: bytes.length,
    chunkSize: PRIME_BLOB_CONFIG.chunkSizeBytes,
    dataShards: PRIME_BLOB_CONFIG.k,
    totalShards: PRIME_BLOB_CONFIG.n,
    chunkCommitments,
    chunksetCommitment,
    clayChunkRoots: clay.chunkRoots.map(hex),
    clayChunksetRoot: hex(clay.chunksetRoot)
  };
}

export async function prepareBlob(input, { name, expirationSeconds, expiresAt = 0, blobId } = {}) {
  validateName(name);
  const now = Math.floor(Date.now() / 1000);
  let resolvedExpiresAt = Number(expiresAt || 0);
  if (expirationSeconds !== undefined) {
    const seconds = Number(expirationSeconds);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("expirationSeconds must be a positive integer");
    resolvedExpiresAt = now + seconds;
  }
  if (!Number.isSafeInteger(resolvedExpiresAt) || resolvedExpiresAt < 0 || (resolvedExpiresAt > 0 && resolvedExpiresAt <= now)) {
    throw new Error("expiresAt must be zero or a future UNIX timestamp");
  }

  const encoder = await createEncoder(PRIME_BLOB_CONFIG);
  const encoded = encodeInput(await blobBytes(input), encoder);
  const resolvedBlobId = blobId || `0x${randomBytes(32).toString("hex")}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(resolvedBlobId)) throw new Error("blobId must be a 32-byte hex identifier");

  return {
    blobId: resolvedBlobId,
    name,
    commitment: `0x${encoded.clayChunksetRoot}`,
    size: encoded.size,
    chunkSize: encoded.chunkSize,
    dataShards: encoded.dataShards,
    totalShards: encoded.totalShards,
    expiresAt: resolvedExpiresAt,
    chunkCommitments: encoded.chunkCommitments,
    clayChunkRoots: encoded.clayChunkRoots
  };
}

export async function blobBytes(input) {
  if (input && typeof input.arrayBuffer === "function") return Buffer.from(await input.arrayBuffer());
  return asBuffer(input);
}
