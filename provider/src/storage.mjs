import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function shardCommitment(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatePart(value, label) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export class ShardConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShardConflictError";
    this.code = "SHARD_CONFLICT";
  }
}

export class ProviderStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    return this;
  }

  filePaths(blobId, shardIndex) {
    const safeBlobId = validatePart(String(blobId), "blob id");
    const safeShardIndex = validatePart(String(shardIndex), "shard index");
    const prefix = path.join(this.dataDir, `${safeBlobId}.${safeShardIndex}`);
    return { dataPath: `${prefix}.shard`, metadataPath: `${prefix}.json` };
  }

  async putShard({ blobId, shardIndex, bytes, commitment }) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const computedCommitment = shardCommitment(data);
    if (commitment && commitment !== computedCommitment) {
      throw new Error("shard commitment mismatch");
    }

    const paths = this.filePaths(blobId, shardIndex);
    try {
      const existing = JSON.parse(await readFile(paths.metadataPath, "utf8"));
      if (existing.commitment !== computedCommitment || existing.size !== data.length) {
        throw new ShardConflictError("shard already exists with different content");
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = `${paths.dataPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, data, { mode: 0o600 });
    const handle = await open(temporaryPath, "r");
    await handle.sync();
    await handle.close();
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, paths.dataPath);

    const metadata = {
      blobId: String(blobId),
      shardIndex: Number(shardIndex),
      size: data.length,
      commitment: computedCommitment,
      storedAt: new Date().toISOString()
    };
    await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await chmod(paths.metadataPath, 0o600);
    return metadata;
  }

  async getShardMetadata(blobId, shardIndex) {
    const { metadataPath } = this.filePaths(blobId, shardIndex);
    return JSON.parse(await readFile(metadataPath, "utf8"));
  }

  async readShard(blobId, shardIndex, { start = 0, endExclusive } = {}) {
    const { dataPath } = this.filePaths(blobId, shardIndex);
    const fileStats = await stat(dataPath);
    const safeStart = Math.max(0, Math.min(start, fileStats.size));
    const safeEnd = Math.max(safeStart, Math.min(endExclusive ?? fileStats.size, fileStats.size));
    const length = safeEnd - safeStart;
    const bytes = Buffer.alloc(length);
    const handle = await open(dataPath, "r");
    try {
      await handle.read(bytes, 0, length, safeStart);
    } finally {
      await handle.close();
    }
    return { bytes, size: fileStats.size, start: safeStart, endExclusive: safeEnd };
  }
}

