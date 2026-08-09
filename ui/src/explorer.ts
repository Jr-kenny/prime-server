import type { Address } from "viem";
import { parseEventLogs } from "viem";
import { registryAbi } from "./registry";
import { formatBytes, shortHex } from "./prime";

export type Placement = {
  shard: number;
  provider: string;
  providerId: number;
  endpoint?: string;
  acknowledged: boolean;
};

export type ExplorerBlob = {
  id: string;
  name: string;
  owner: string;
  size: number;
  expiresAt: number;
  status: string;
  acknowledgementCount: number;
  dataShards: number;
  totalShards: number;
  commitment: string;
  storageMode: string;
  accessPolicy: string;
  paymentStatus: string;
  origin: string;
  createdBlock?: string;
  transaction?: string;
  policyCommitment?: string;
  keyEnvelopeCommitment?: string;
  metadataCommitment?: string;
  placements: Placement[];
};

export type ExplorerEvent = {
  id: string;
  type: string;
  transaction: string;
  owner: string;
  name: string;
  time: string;
  block: string;
  blobId?: string;
  detail?: string;
};

export type ExplorerProvider = {
  id: number;
  operator: string;
  endpoint: string;
  active: boolean;
  registeredBlock?: string;
};

export type ExplorerStats = {
  blobs: number;
  activeBlobs: number;
  storageUsed: number;
  events: number;
  recoveries: number;
  placementGroups: number;
  providers: number;
  activeProviders: number;
};

export type ExplorerData = {
  source: "coston2";
  latestBlock?: string;
  indexedBlock?: string;
  fromBlock?: string;
  blobs: ExplorerBlob[];
  events: ExplorerEvent[];
  providers: ExplorerProvider[];
  stats: ExplorerStats;
};

const statusNames = ["Pending", "Active", "Recovering", "Rebuilt", "Revoked"];
const storageModeNames = ["Public", "Private", "Confidential"];
const accessPolicyNames = ["Owner only", "Selected wallets", "Compute only"];
const paymentStatusNames = ["Unpaid", "Escrowed", "Claimable", "Partially settled", "Settled", "Refunded"];

function makeStats(blobs: ExplorerBlob[], events: ExplorerEvent[], providers: ExplorerProvider[]): ExplorerStats {
  return {
    blobs: blobs.length,
    activeBlobs: blobs.filter((blob) => blob.status === "Active" || blob.status === "Rebuilt").length,
    storageUsed: blobs.reduce((total, blob) => total + blob.size, 0),
    events: events.length,
    recoveries: events.filter((event) => event.type === "Recovery" || event.type === "Rebuilt").length,
    placementGroups: blobs.length,
    providers: providers.length,
    activeProviders: providers.filter((provider) => provider.active).length
  };
}

export const emptyExplorerData: ExplorerData = {
  source: "coston2",
  blobs: [],
  events: [],
  providers: [],
  stats: makeStats([], [], [])
};

function valueOf(args: Record<string, unknown> | undefined, key: string, index: number) {
  return args?.[key] ?? args?.[index];
}

function eventType(eventName: string) {
  const names: Record<string, string> = {
    BlobCreated: "Registered",
    BlobNamed: "Named",
    BlobFinalized: "Finalized",
    ShardAssigned: "Assigned",
    ShardAcknowledged: "Acknowledged",
    RecoveryStarted: "Recovery",
    ShardRebuilt: "Rebuilt",
    BlobPolicyRecorded: "Policy",
    PaymentEscrowed: "Payment",
    ProviderSettlementClaimed: "Settled",
    ProviderRegistered: "Provider",
    ProviderStatusChanged: "Provider"
  };
  return names[eventName] || eventName;
}

function asString(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown) {
  return Number(value || 0);
}

function blockLabel(value: unknown) {
  return value === undefined ? "Unknown" : `Block ${asString(value)}`;
}

async function readContract(client: any, address: Address, functionName: string, args: readonly unknown[] = []) {
  return client.readContract({ address, abi: registryAbi, functionName, args });
}

type ExplorerApiLog = {
  address?: { hash?: string };
  block_number: number;
  transaction_hash: string;
  index: number;
  data: string;
  topics: Array<string | null>;
};

function mapExplorerApiLog(log: ExplorerApiLog, address: Address) {
  return {
    address: (log.address?.hash || address) as Address,
    blockNumber: BigInt(log.block_number),
    transactionHash: log.transaction_hash,
    logIndex: log.index,
    data: log.data,
    topics: log.topics.filter((topic): topic is string => Boolean(topic))
  };
}

async function loadExplorerLogs(address: Address, fromBlock: bigint, latestBlock: bigint) {
  const apiBase = (import.meta.env.VITE_COSTON2_EXPLORER_API_URL || "https://coston2-explorer.flare.network/api/v2").replace(/\/$/, "");
  const logs: any[] = [];
  let nextPageParams: Record<string, string | number> | undefined;
  let indexedBlock: bigint | undefined;

  while (true) {
    const url = new URL(`${apiBase}/addresses/${address}/logs`);
    if (nextPageParams) {
      for (const [key, value] of Object.entries(nextPageParams)) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Coston2 event index returned HTTP ${response.status}`);
    const payload = await response.json() as { items?: ExplorerApiLog[]; next_page_params?: Record<string, string | number> | null; errors?: Array<{ detail?: string }> };
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.detail || "Coston2 event index error").join(", "));

    let reachedStart = false;
    for (const item of payload.items || []) {
      const blockNumber = BigInt(item.block_number);
      if (blockNumber > latestBlock) continue;
      if (blockNumber < fromBlock) {
        reachedStart = true;
        break;
      }
      indexedBlock = indexedBlock === undefined || blockNumber > indexedBlock ? blockNumber : indexedBlock;
      logs.push(mapExplorerApiLog(item, address));
    }
    if (reachedStart || !payload.next_page_params) break;
    nextPageParams = payload.next_page_params;
  }

  return { logs, indexedBlock };
}

export async function loadExplorerData(client: any, address: Address): Promise<ExplorerData> {
  const latestBlock = await client.getBlockNumber();
  const configuredFrom = import.meta.env.VITE_REGISTRY_DEPLOYMENT_BLOCK;
  const fallbackFrom = latestBlock > 75_000n ? latestBlock - 75_000n : 0n;
  const fromBlock = configuredFrom ? BigInt(configuredFrom) : fallbackFrom;
  const { logs, indexedBlock } = await loadExplorerLogs(address, fromBlock, latestBlock);
  const parsed = parseEventLogs({ abi: registryAbi, logs, strict: false }) as Array<any>;
  const blobsById = new Map<string, { owner: string; name: string; createdBlock?: string; transaction?: string }>();
  const providersById = new Map<number, ExplorerProvider>();

  for (const event of parsed) {
    const args = event.args as Record<string, unknown> | undefined;
    const blobId = asString(valueOf(args, "blobId", 0));
    if (event.eventName === "BlobCreated" && blobId) {
      blobsById.set(blobId, {
        owner: asString(valueOf(args, "owner", 1)),
        name: "Unnamed blob",
        createdBlock: asString(event.blockNumber),
        transaction: event.transactionHash
      });
    }
    if (event.eventName === "BlobNamed" && blobId) {
      const current = blobsById.get(blobId);
      blobsById.set(blobId, {
        owner: asString(valueOf(args, "owner", 1)) || current?.owner || "",
        name: asString(valueOf(args, "blobName", 3)) || current?.name || "Unnamed blob",
        createdBlock: current?.createdBlock || asString(event.blockNumber),
        transaction: current?.transaction || event.transactionHash
      });
    }
    if (event.eventName === "ProviderRegistered") {
      const id = asNumber(valueOf(args, "providerId", 0));
      providersById.set(id, {
        id,
        operator: asString(valueOf(args, "operator", 1)),
        endpoint: asString(valueOf(args, "endpoint", 2)),
        active: true,
        registeredBlock: asString(event.blockNumber)
      });
    }
    if (event.eventName === "ProviderStatusChanged") {
      const id = asNumber(valueOf(args, "providerId", 0));
      const current = providersById.get(id);
      if (current) current.active = Boolean(valueOf(args, "active", 1));
    }
  }

  const events: ExplorerEvent[] = parsed.map((event, index) => {
    const args = event.args as Record<string, unknown> | undefined;
    const blobId = asString(valueOf(args, "blobId", 0));
    const blob = blobsById.get(blobId);
    let detail = "";
    if (event.eventName === "ShardAssigned" || event.eventName === "ShardAcknowledged" || event.eventName === "ShardRebuilt") {
      detail = `Shard ${asNumber(valueOf(args, "shardIndex", 1))} · Provider ${asNumber(valueOf(args, "providerId", 2))}`;
    }
    if (event.eventName === "RecoveryStarted") {
      detail = `Shard ${asNumber(valueOf(args, "shardIndex", 2))} · Provider ${asNumber(valueOf(args, "providerId", 1))}`;
    }
    if (event.eventName === "PaymentEscrowed") {
      detail = `${asString(valueOf(args, "amount", 3))} wei escrowed`;
    }
    return {
      id: `${event.transactionHash || "event"}-${asString(event.logIndex ?? index)}`,
      type: eventType(event.eventName),
      transaction: asString(event.transactionHash),
      owner: blob?.owner || asString(valueOf(args, "operator", 1)) || asString(valueOf(args, "payer", 1)),
      name: blob?.name || (event.eventName === "ProviderRegistered" ? `Provider ${asNumber(valueOf(args, "providerId", 0))}` : "Network event"),
      time: blockLabel(event.blockNumber),
      block: asString(event.blockNumber),
      blobId: blobId || undefined,
      detail: detail || undefined
    };
  }).sort((a, b) => Number(b.block) - Number(a.block));

  const blobs = (await Promise.all([...blobsById.entries()].map(async ([id, meta]) => {
    try {
      const raw = await readContract(client, address, "blobs", [id]);
      if (!raw?.[8]) return null;
      const totalShards = asNumber(raw[5]);
      const policy = await readContract(client, address, "getBlobPolicy", [id]).catch(() => undefined);
      const payment = await readContract(client, address, "getBlobPayment", [id]).catch(() => undefined);
      const placements = await Promise.all(Array.from({ length: totalShards }, async (_, shard) => {
        const providerId = asNumber(await readContract(client, address, "placement", [id, shard]).catch(() => 0n));
        const provider = providersById.get(providerId);
        const acknowledged = providerId > 0 && (Boolean(await readContract(client, address, "acknowledgements", [id, providerId, shard]).then((ack: any) => ack?.[3]).catch(() => false)) || shard < asNumber(raw[6]));
        return { shard, providerId, provider: provider ? `Provider ${providerId}` : providerId ? `Provider ${providerId}` : "Awaiting assignment", endpoint: provider?.endpoint, acknowledged };
      }));
      const policyStorageMode = asNumber(valueOf(policy as Record<string, unknown> | undefined, "storageMode", 0));
      const policyAccess = asNumber(valueOf(policy as Record<string, unknown> | undefined, "accessPolicy", 1));
      return {
        id,
        name: (await readContract(client, address, "blobNames", [id]).catch(() => meta.name)) || meta.name,
        owner: asString(raw[0]) || meta.owner,
        size: asNumber(raw[2]),
        expiresAt: asNumber(raw[9]),
        status: statusNames[asNumber(raw[7])] || "Unknown",
        acknowledgementCount: asNumber(raw[6]),
        dataShards: asNumber(raw[4]),
        totalShards,
        commitment: asString(raw[1]),
        storageMode: storageModeNames[policyStorageMode] || "Public",
        accessPolicy: accessPolicyNames[policyAccess] || "Owner only",
        paymentStatus: paymentStatusNames[asNumber(valueOf(payment as Record<string, unknown> | undefined, "status", 1))] || "Unpaid",
        origin: asNumber(raw[10]) === 1 ? "Operator" : "User",
        createdBlock: meta.createdBlock,
        transaction: meta.transaction,
        policyCommitment: asString(valueOf(policy as Record<string, unknown> | undefined, "policyCommitment", 2)) || undefined,
        keyEnvelopeCommitment: asString(valueOf(policy as Record<string, unknown> | undefined, "keyEnvelopeCommitment", 3)) || undefined,
        metadataCommitment: asString(valueOf(policy as Record<string, unknown> | undefined, "metadataCommitment", 4)) || undefined,
        placements
      } as ExplorerBlob;
    } catch {
      return null;
    }
  }))).filter((blob): blob is ExplorerBlob => Boolean(blob));

  const providers = [...providersById.values()].sort((a, b) => a.id - b.id);
  return {
    source: "coston2",
    latestBlock: latestBlock.toString(),
    indexedBlock: indexedBlock?.toString(),
    fromBlock: fromBlock.toString(),
    blobs,
    events,
    providers,
    stats: makeStats(blobs, events, providers)
  };
}

export function blobStatusClass(status: string) {
  return status.toLowerCase().replace(/\s+/g, "-");
}

export function blobExpiry(expiresAt: number) {
  return expiresAt ? new Date(expiresAt * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "No expiry";
}

export function eventTransaction(event: ExplorerEvent) {
  return event.transaction.startsWith("0x") ? shortHex(event.transaction, 12, 7) : event.transaction;
}

export function statsDetail(stats: ExplorerStats) {
  return `${stats.activeProviders}/${stats.providers || 0} active on registry`;
}

export { formatBytes };
