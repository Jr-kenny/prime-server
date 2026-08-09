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
  source: "preview" | "coston2";
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

const previewBlobs: ExplorerBlob[] = [
  {
    name: "archive/product-design.fig",
    id: "0x3a44f127e9c82de016ab6918a26354b2156e951cdf9",
    owner: "0x71b2…9a0e",
    size: 1_820_000,
    expiresAt: Date.parse("2026-09-14T00:00:00Z") / 1000,
    status: "Active",
    acknowledgementCount: 4,
    dataShards: 2,
    totalShards: 4,
    commitment: "0x4fc0a34f99dd2d6f26c1fa1b5c4bca7c7e2d10024fb7bb1d4c62f0f2d1f5e99b",
    storageMode: "Public",
    accessPolicy: "Owner only",
    paymentStatus: "Settled",
    origin: "User",
    placements: [1, 2, 3, 4].map((providerId, shard) => ({ shard, providerId, provider: `Provider ${providerId}`, endpoint: `https://provider-${providerId}.prime.network`, acknowledged: true }))
  },
  {
    name: "research/flare-notes.pdf",
    id: "0x17e8a035b02c27d4923c51d8b8e1e935f01b763dc0",
    owner: "0x71b2…9a0e",
    size: 884_000,
    expiresAt: Date.parse("2026-09-08T00:00:00Z") / 1000,
    status: "Active",
    acknowledgementCount: 4,
    dataShards: 2,
    totalShards: 4,
    commitment: "0xcab418e1a984f507c9e5376087ce51a0272f62c7a3d55ba327a1bcd81db9a0f4",
    storageMode: "Public",
    accessPolicy: "Owner only",
    paymentStatus: "Settled",
    origin: "User",
    placements: [1, 2, 3, 4].map((providerId, shard) => ({ shard, providerId, provider: `Provider ${providerId}`, endpoint: `https://provider-${providerId}.prime.network`, acknowledged: true }))
  },
  {
    name: "exports/protocol-state.json",
    id: "0x982cf48f9aab338129d418ee2f55e6c68d9132fe1a",
    owner: "0xc12a…61f4",
    size: 42_800,
    expiresAt: Date.parse("2026-08-30T00:00:00Z") / 1000,
    status: "Pending",
    acknowledgementCount: 2,
    dataShards: 2,
    totalShards: 4,
    commitment: "0x772db7f7c4f7c2a12d7d1f9f2c0e1c5a1c6f9cc125b7b1a4cd1ef5d0f4b8ef10",
    storageMode: "Public",
    accessPolicy: "Owner only",
    paymentStatus: "Escrowed",
    origin: "User",
    placements: [1, 2, 3, 4].map((providerId, shard) => ({ shard, providerId, provider: `Provider ${providerId}`, endpoint: `https://provider-${providerId}.prime.network`, acknowledged: shard < 2 }))
  },
  {
    name: "private/8dc1…e244",
    id: "0x8dc10b2b5da086a7fa36f1740b47c0ad43e244",
    owner: "0x49d0…a421",
    size: 1_040_000,
    expiresAt: Date.parse("2026-08-21T00:00:00Z") / 1000,
    status: "Active",
    acknowledgementCount: 4,
    dataShards: 2,
    totalShards: 4,
    commitment: "0x99f0e4f7a0bf8e38a4f4dd783f8f10e4574f6c6b6d25dd4d9c8d44d7b7e6a111",
    storageMode: "Private",
    accessPolicy: "Selected wallets",
    paymentStatus: "Settled",
    origin: "User",
    placements: [1, 2, 3, 4].map((providerId, shard) => ({ shard, providerId, provider: `Provider ${providerId}`, endpoint: `https://provider-${providerId}.prime.network`, acknowledged: true }))
  }
];

const previewEvents: ExplorerEvent[] = [
  { id: "preview-1", type: "Finalized", transaction: "0x1c94…a8f21", owner: "0x71b2…9a0e", name: "archive/product-design.fig", time: "11:18:42 PM", block: "Preview" },
  { id: "preview-2", type: "Acknowledged", transaction: "0x8be1…f10c4", owner: "0x71b2…9a0e", name: "research/flare-notes.pdf", time: "11:18:36 PM", block: "Preview" },
  { id: "preview-3", type: "Assigned", transaction: "0x52bd…90e13", owner: "0xc12a…61f4", name: "exports/protocol-state.json", time: "11:17:55 PM", block: "Preview" },
  { id: "preview-4", type: "Registered", transaction: "0xd701…c2a48", owner: "0x49d0…a421", name: "private/8dc1…e244", time: "11:16:09 PM", block: "Preview" },
  { id: "preview-5", type: "Recovery", transaction: "0xa18f…77d03", owner: "0x71b2…9a0e", name: "archive/product-design.fig", time: "10:52:14 PM", block: "Preview" }
];

const previewProviders: ExplorerProvider[] = [1, 2, 3, 4].map((id) => ({
  id,
  operator: `0x${["71b2", "c12a", "49d0", "8ab4"][id - 1]}…${["9a0e", "61f4", "a421", "ff19"][id - 1]}`,
  endpoint: `https://provider-${id}.prime.network`,
  active: true,
  registeredBlock: "Preview"
}));

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

export const previewData: ExplorerData = {
  source: "preview",
  latestBlock: "Preview",
  indexedBlock: "Preview",
  fromBlock: "Preview",
  blobs: previewBlobs,
  events: previewEvents,
  providers: previewProviders,
  stats: makeStats(previewBlobs, previewEvents, previewProviders)
};

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
