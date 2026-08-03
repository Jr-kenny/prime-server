import { createHash } from "node:crypto";
import { createDecoder, createEncoder } from "@shelby-protocol/clay-codes";

export const FOUR_PROVIDER_CONFIG = Object.freeze({
  n: 4,
  k: 2,
  d: 3,
  chunkSizeBytes: 1024 * 1024
});

export const MIN_CLAY_CHUNK_SIZE_BYTES = 1024 * 1024;

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateConfig(config) {
  if (!Number.isInteger(config.n) || !Number.isInteger(config.k) || !Number.isInteger(config.d)) {
    throw new Error("erasure parameters must be integers");
  }
  if (config.n < config.k || config.k < 1 || config.d < config.k || config.chunkSizeBytes < MIN_CLAY_CHUNK_SIZE_BYTES) {
    throw new Error("invalid erasure parameters");
  }
}

function padInput(input, config) {
  const bytes = Buffer.from(input);
  const capacity = config.k * config.chunkSizeBytes;
  if (bytes.length > capacity) {
    throw new Error(`input is ${bytes.length} bytes but this chunkset holds ${capacity} bytes`);
  }
  const padded = Buffer.alloc(capacity);
  bytes.copy(padded);
  return { originalSize: bytes.length, padded };
}

function contentCommitment(chunks) {
  const chunkCommitments = chunks.map((chunk) => sha256(chunk));
  const chunksetCommitment = sha256(Buffer.from(chunkCommitments.join(""), "hex"));
  return { chunkCommitments, chunksetCommitment };
}

export async function createErasureEngine(config = FOUR_PROVIDER_CONFIG) {
  validateConfig(config);
  const encoder = await createEncoder(config);

  return {
    config: { ...config },

    encode(input) {
      const { originalSize, padded } = padInput(input, config);
      const collection = encoder.erasureCode(padded);
      const chunks = collection.chunks.map((chunk) => Buffer.from(chunk));
      const clay = encoder.getMerkleCommitment();
      const content = contentCommitment(chunks);
      return {
        originalSize,
        paddedSize: padded.length,
        chunks,
        chunkCommitments: content.chunkCommitments,
        chunksetCommitment: content.chunksetCommitment,
        clayChunkRoots: clay.chunkRoots.map(hex),
        clayChunksetRoot: hex(clay.chunksetRoot)
      };
    },

    async decode(available, erasedChunkIndexes, originalSize) {
      const erased = [...new Set(erasedChunkIndexes)].sort((a, b) => a - b);
      if (erased.length === 0 || erased.some((index) => index < 0 || index >= config.n)) {
        throw new Error("invalid erased chunk indexes");
      }

      const availableIndexes = Array.from({ length: config.n }, (_, index) => index)
        .filter((index) => !erased.includes(index));
      if (available.length !== availableIndexes.length) {
        throw new Error(`expected ${availableIndexes.length} available chunks`);
      }
      if (available.length < config.k) {
        throw new Error(`at least ${config.k} chunks are required for recovery`);
      }

      const chunksByIndex = new Map(available.map(({ index, bytes }) => [index, Buffer.from(bytes)]));
      const ordered = availableIndexes.map((index) => {
        const bytes = chunksByIndex.get(index);
        if (!bytes) throw new Error(`missing available chunk ${index}`);
        return bytes;
      });

      const decoder = await createDecoder({ ...config, erasedChunkIndexes: erased });
      const collection = decoder.decode(ordered, { erasedChunkIndexes: erased });
      const chunks = collection.chunks.map((chunk) => Buffer.from(chunk));
      const recovered = Buffer.concat(collection.systematic).subarray(0, originalSize);
      const decoderChunkRoots = decoder.getChunkMerkleRoots().map(hex);
      const verificationEncoder = await createEncoder(config);
      verificationEncoder.erasureCode(Buffer.concat(collection.systematic));
      const clay = verificationEncoder.getMerkleCommitment();
      const clayChunkRoots = clay.chunkRoots.map(hex);
      if (decoderChunkRoots.join("") !== clayChunkRoots.join("")) {
        throw new Error("recovered Clay commitments do not match");
      }
      const content = contentCommitment(chunks);

      return {
        originalSize,
        chunks,
        recovered,
        chunkCommitments: content.chunkCommitments,
        chunksetCommitment: content.chunksetCommitment,
        clayChunkRoots,
        clayChunksetRoot: hex(clay.chunksetRoot)
      };
    }
  };
}
