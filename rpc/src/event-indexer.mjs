import { parseEventLogs } from "viem";
import { primeServerRegistryAbi } from "./registry-abi.mjs";

export class PrimeServerEventIndexer {
  constructor({ publicClient, address, fromBlock = 0n, maxBlockRange = 30n, stateStore, cursorKey } = {}) {
    if (!publicClient) throw new Error("publicClient is required");
    if (!address) throw new Error("registry address is required");
    if (BigInt(maxBlockRange) < 1n) throw new Error("maxBlockRange must be positive");
    this.publicClient = publicClient;
    this.address = address;
    this.nextBlock = BigInt(fromBlock);
    this.maxBlockRange = BigInt(maxBlockRange);
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
    for (let fromBlock = this.nextBlock; fromBlock <= latest; fromBlock += this.maxBlockRange) {
      const toBlock = fromBlock + this.maxBlockRange - 1n < latest
        ? fromBlock + this.maxBlockRange - 1n
        : latest;
      const logs = await this.publicClient.getLogs({ address: this.address, fromBlock, toBlock });
      const parsed = parseEventLogs({ abi: primeServerRegistryAbi, logs, strict: false });
      records.push(...parsed.map((event) => ({
        eventName: event.eventName,
        args: event.args,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex
      })));
    }
    const nextBlock = latest + 1n;
    if (this.stateStore) await this.stateStore.setCursor(this.cursorKey, nextBlock);
    this.events.push(...records);
    this.nextBlock = nextBlock;
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
