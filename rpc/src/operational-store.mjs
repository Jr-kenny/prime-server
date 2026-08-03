import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    cursors: {},
    recoveryJobs: {}
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function timestamp() {
  return new Date().toISOString();
}

function normalizeMissingShards(missingShards = []) {
  return [...new Set(missingShards.map((shardIndex) => Number(shardIndex)))].sort((a, b) => a - b);
}

function validateState(state) {
  if (!state || state.version !== STATE_VERSION || typeof state.cursors !== "object" || typeof state.recoveryJobs !== "object") {
    throw new Error("unsupported operational state format");
  }
  return state;
}

export class JsonOperationalStore {
  constructor(filePath) {
    if (!filePath) throw new Error("operational state path is required");
    this.filePath = path.resolve(filePath);
    this.state = null;
    this.lock = Promise.resolve();
    this.readyPromise = this.load();
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = validateState(JSON.parse(await readFile(this.filePath, "utf8")));
      return this;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = emptyState();
      await this.persist();
      return this;
    }
  }

  async ready() {
    await this.readyPromise;
    return this;
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async update(mutator) {
    await this.ready();
    const operation = this.lock.then(async () => {
      const result = await mutator(this.state);
      await this.persist();
      return clone(result);
    });
    this.lock = operation.catch(() => undefined);
    return operation;
  }

  async snapshot() {
    await this.ready();
    await this.lock;
    return clone(this.state);
  }

  async getCursor(key) {
    if (!key) throw new Error("cursor key is required");
    await this.ready();
    await this.lock;
    return this.state.cursors[key] ?? null;
  }

  async setCursor(key, nextBlock) {
    if (!key) throw new Error("cursor key is required");
    const normalized = BigInt(nextBlock);
    if (normalized < 0n) throw new Error("cursor cannot be negative");
    return this.update((state) => {
      state.cursors[key] = normalized.toString();
      return state.cursors[key];
    });
  }

  async getRecoveryJob(jobId) {
    if (!jobId) throw new Error("recovery job ID is required");
    await this.ready();
    await this.lock;
    return clone(this.state.recoveryJobs[jobId] || null);
  }

  async listRecoveryJobs() {
    await this.ready();
    await this.lock;
    return Object.values(clone(this.state.recoveryJobs)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async enqueueRecovery({ blobId, reason = "provider_failure", missingShards = [] } = {}) {
    if (!blobId) throw new Error("blob ID is required for recovery");
    const jobId = String(blobId);
    const normalizedMissingShards = normalizeMissingShards(missingShards);
    return this.update((state) => {
      const current = state.recoveryJobs[jobId];
      const now = timestamp();
      if (current?.status === "succeeded") return current;
      if (current?.status === "queued" || current?.status === "running") return current;

      const job = current || {
        jobId,
        blobId: String(blobId),
        attempts: 0,
        createdAt: now
      };
      Object.assign(job, {
        status: "queued",
        reason,
        missingShards: normalizedMissingShards,
        updatedAt: now,
        leaseUntil: null,
        lastError: null
      });
      state.recoveryJobs[jobId] = job;
      return job;
    });
  }

  async claimRecovery({ workerId = `worker-${process.pid}`, leaseMs = 60_000 } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("recovery lease must be positive");
    return this.update((state) => {
      const now = Date.now();
      const jobs = Object.values(state.recoveryJobs);
      for (const job of jobs) {
        if (job.status === "running" && job.leaseUntil && Date.parse(job.leaseUntil) <= now) {
          job.status = "queued";
          job.leaseUntil = null;
          job.updatedAt = timestamp();
        }
      }
      const next = jobs
        .filter((job) => job.status === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!next) return null;

      next.status = "running";
      next.workerId = workerId;
      next.attempts += 1;
      next.updatedAt = timestamp();
      next.leaseUntil = new Date(now + leaseMs).toISOString();
      return next;
    });
  }

  async completeRecovery(jobId, result) {
    return this.update((state) => {
      const job = state.recoveryJobs[jobId];
      if (!job) throw new Error(`recovery job ${jobId} not found`);
      if (job.status === "succeeded") return job;
      job.status = "succeeded";
      job.result = clone(result);
      job.completedAt = timestamp();
      job.updatedAt = job.completedAt;
      job.leaseUntil = null;
      job.lastError = null;
      return job;
    });
  }

  async failRecovery(jobId, error, { retry = true } = {}) {
    return this.update((state) => {
      const job = state.recoveryJobs[jobId];
      if (!job) throw new Error(`recovery job ${jobId} not found`);
      if (job.status === "succeeded") return job;
      job.status = retry ? "queued" : "failed";
      job.updatedAt = timestamp();
      job.leaseUntil = null;
      job.lastError = error instanceof Error ? error.message : String(error);
      return job;
    });
  }
}
