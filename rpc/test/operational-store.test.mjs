import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrimeServerEventIndexer } from "../src/event-indexer.mjs";
import { JsonOperationalStore } from "../src/operational-store.mjs";
import { PrimeServerRecoveryCoordinator } from "../src/recovery-coordinator.mjs";

test("operational cursor survives an indexer restart and respects bounded log windows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-operational-"));
  const statePath = path.join(root, "state.json");
  const windows = [];
  const publicClient = {
    async getBlockNumber() {
      return 7n;
    },
    async getLogs({ fromBlock, toBlock }) {
      windows.push([fromBlock, toBlock]);
      return [];
    }
  };

  try {
    const firstStore = new JsonOperationalStore(statePath);
    const firstIndexer = new PrimeServerEventIndexer({
      publicClient,
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: 1n,
      maxBlockRange: 3n,
      stateStore: firstStore
    });
    await firstIndexer.poll();
    assert.deepEqual(windows, [[1n, 3n], [4n, 6n], [7n, 7n]]);
    assert.equal(await firstStore.getCursor(firstIndexer.cursorKey), "8");

    const secondStore = new JsonOperationalStore(statePath);
    const secondIndexer = new PrimeServerEventIndexer({
      publicClient,
      address: firstIndexer.address,
      fromBlock: 1n,
      maxBlockRange: 3n,
      stateStore: secondStore
    });
    assert.deepEqual(await secondIndexer.poll(), []);
    assert.equal(secondIndexer.nextBlock, 8n);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).cursors[secondIndexer.cursorKey], "8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event indexer checkpoints successful windows before an RPC failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-indexer-checkpoint-"));
  const statePath = path.join(root, "state.json");
  const windows = [];
  let failAtSeven = true;
  const publicClient = {
    async getBlockNumber() { return 20n; },
    async getLogs({ fromBlock, toBlock }) {
      windows.push([fromBlock, toBlock]);
      if (failAtSeven && fromBlock === 7n) throw new Error("simulated RPC rate limit");
      return [];
    }
  };

  try {
    const firstStore = new JsonOperationalStore(statePath);
    const firstIndexer = new PrimeServerEventIndexer({
      publicClient,
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: 1n,
      maxBlockRange: 3n,
      maxRangesPerPoll: 4,
      stateStore: firstStore
    });
    await assert.rejects(() => firstIndexer.poll(), /simulated RPC rate limit/);
    assert.equal(await firstStore.getCursor(firstIndexer.cursorKey), "7");

    failAtSeven = false;
    const secondIndexer = new PrimeServerEventIndexer({
      publicClient,
      address: firstIndexer.address,
      fromBlock: 1n,
      maxBlockRange: 3n,
      maxRangesPerPoll: 4,
      stateStore: new JsonOperationalStore(statePath)
    });
    await secondIndexer.poll();
    assert.deepEqual(windows, [[1n, 3n], [4n, 6n], [7n, 9n], [7n, 9n], [10n, 12n], [13n, 15n], [16n, 18n]]);
    assert.equal(secondIndexer.nextBlock, 19n);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery jobs survive failure, retry, completion, and coordinator restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-recovery-"));
  const statePath = path.join(root, "state.json");
  let attempts = 0;

  try {
    const store = new JsonOperationalStore(statePath);
    const coordinator = new PrimeServerRecoveryCoordinator({
      store,
      workerId: "test-worker",
      recover: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("provider still unavailable");
        return { status: "rebuilt", contentHash: "abc123" };
      }
    });

    await assert.rejects(() => coordinator.recoverBlob({ blobId: "blob-1", missingShards: [3, 1, 3] }), /provider still unavailable/);
    const queuedAfterFailure = await store.getRecoveryJob("blob-1");
    assert.equal(queuedAfterFailure.status, "queued");
    assert.deepEqual(queuedAfterFailure.missingShards, [1, 3]);
    assert.equal(queuedAfterFailure.attempts, 1);

    const result = await coordinator.recoverBlob({ blobId: "blob-1" });
    assert.deepEqual(result, { status: "rebuilt", contentHash: "abc123" });

    const restartedStore = new JsonOperationalStore(statePath);
    const restartedCoordinator = new PrimeServerRecoveryCoordinator({
      store: restartedStore,
      recover: async () => {
        throw new Error("should not run a completed job");
      }
    });
    assert.deepEqual(await restartedCoordinator.recoverBlob({ blobId: "blob-1" }), result);
    const completed = await restartedStore.getRecoveryJob("blob-1");
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.attempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
