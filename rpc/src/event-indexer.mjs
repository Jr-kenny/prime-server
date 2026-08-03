import { parseEventLogs } from "viem";
import { primeServerRegistryAbi } from "./registry-abi.mjs";

export class PrimeServerEventIndexer {
  constructor({ publicClient, address, fromBlock = 0n } = {}) {
    if (!publicClient) throw new Error("publicClient is required");
    if (!address) throw new Error("registry address is required");
    this.publicClient = publicClient;
    this.address = address;
    this.nextBlock = BigInt(fromBlock);
    this.events = [];
  }

  async poll(toBlock) {
    const latest = toBlock === undefined ? await this.publicClient.getBlockNumber() : BigInt(toBlock);
    if (latest < this.nextBlock) return [];
    const logs = await this.publicClient.getLogs({
      address: this.address,
      fromBlock: this.nextBlock,
      toBlock: latest
    });
    const parsed = parseEventLogs({ abi: primeServerRegistryAbi, logs, strict: false });
    const records = parsed.map((event) => ({
      eventName: event.eventName,
      args: event.args,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex
    }));
    this.events.push(...records);
    this.nextBlock = latest + 1n;
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

