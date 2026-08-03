const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PrimeServerRecoveryCoordinator {
  constructor({ store, recover, workerId = `recovery-worker-${process.pid}`, leaseMs = 60_000 } = {}) {
    if (!store) throw new Error("operational store is required");
    if (typeof recover !== "function") throw new Error("recovery handler is required");
    this.store = store;
    this.recover = recover;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
  }

  async enqueue({ blobId, reason = "provider_failure", missingShards = [] } = {}) {
    return this.store.enqueueRecovery({ blobId, reason, missingShards });
  }

  async processNext() {
    const job = await this.store.claimRecovery({ workerId: this.workerId, leaseMs: this.leaseMs });
    if (!job) return null;

    try {
      const result = await this.recover(job.blobId, job);
      const completed = await this.store.completeRecovery(job.jobId, result);
      return { job: completed, result };
    } catch (error) {
      const failed = await this.store.failRecovery(job.jobId, error, { retry: true });
      return { job: failed, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async recoverBlob({ blobId, reason = "api_request", missingShards = [] } = {}) {
    const existing = await this.store.getRecoveryJob(String(blobId));
    if (existing?.status === "succeeded") return existing.result;

    const queued = await this.enqueue({ blobId, reason, missingShards });
    if (queued.status === "queued") {
      const processed = await this.processNext();
      if (processed?.result) return processed.result;
      if (processed?.error) throw new Error(processed.error);
    }

    const deadline = Date.now() + this.leaseMs;
    while (Date.now() < deadline) {
      const current = await this.store.getRecoveryJob(String(blobId));
      if (current?.status === "succeeded") return current.result;
      if (current?.status === "queued") {
        const processed = await this.processNext();
        if (processed?.result) return processed.result;
        if (processed?.error) throw new Error(processed.error);
      }
      await delay(50);
    }
    throw new Error(`recovery job ${blobId} is still running`);
  }

  async listJobs() {
    return this.store.listRecoveryJobs();
  }
}
