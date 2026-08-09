import { parseEventLogs } from "viem";
import { primeServerRegistryAbi } from "./registry-abi.mjs";

export class PrimeServerEventIndexer {
  constructor({ publicClient, address, fromBlock = 0n, maxBlockRange = 2_000n, maxRangesPerPoll = 4, stateStore, cursorKey } = {}) {
    if (!publicClient) throw new Error("publicClient is required");
    if (!address) throw new Error("registry address is required");
    if (BigInt(maxBlockRange) < 1n) throw new Error("maxBlockRange must be positive");
    if (!Number.isSafeInteger(maxRangesPerPoll) || maxRangesPerPoll < 1) throw new Error("maxRangesPerPoll must be positive");
    this.publicClient = publicClient;
    this.address = address;
    this.nextBlock = BigInt(fromBlock);
    this.maxBlockRange = BigInt(maxBlockRange);
    this.maxRangesPerPoll = maxRangesPerPoll;
    this.stateStore = stateStore || null;
    this.cursorKey = cursorKey || address;
    this.events = [];
    this.readyPromise = null;
  }

  async ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (!this.stateStore) return;
        await this.stateStore.ready();
        const storedCursor = await this.stateStore.getCursor(this.cursorKey);
        if (storedCursor !== null) this.nextBlock = BigInt(storedCursor);
      })();
    }
    await this.readyPromise;
    return this;
  }

  async poll(toBlock) {
    await this.ready();
    const latest = toBlock === undefined ? await this.publicClient.getBlockNumber() : BigInt(toBlock);
    if (latest < this.nextBlock) return [];
    const records = [];
    const pollLimit = this.nextBlock + this.maxBlockRange * BigInt(this.maxRangesPerPoll) - 1n;
    const targetBlock = pollLimit < latest ? pollLimit : latest;
    for (let fromBlock = this.nextBlock; fromBlock <= targetBlock; fromBlock += this.maxBlockRange) {
      const toBlock = fromBlock + this.maxBlockRange - 1n < latest
        ? fromBlock + this.maxBlockRange - 1n
        : targetBlock;
      const logs = await this.publicClient.getLogs({ address: this.address, fromBlock, toBlock });
      const parsed = parseEventLogs({ abi: primeServerRegistryAbi, logs, strict: false });
      const windowRecords = parsed.map((event) => ({
        eventName: event.eventName,
        args: event.args,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex
      }));
      records.push(...windowRecords);
      this.events.push(...windowRecords);
      this.nextBlock = toBlock + 1n;
      if (this.stateStore) await this.stateStore.setCursor(this.cursorKey, this.nextBlock);
    }
    return records;
  }

  snapshot() {
    return {
      address: this.address,
      nextBlock: this.nextBlock.toString(),
      events: this.events.map((event) => ({
        ...event,
        blockNumber: event.blockNumber?.toString(),
        logIndex: event.logIndex?.toString(),
        args: Object.fromEntries(Object.entries(event.args || {}).filter(([key]) => Number.isNaN(Number(key))).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))
      }))
    };
  }
}
