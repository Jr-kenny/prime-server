export const blobFinalizedEvent = {
  type: "event",
  name: "BlobFinalized",
  anonymous: false,
  inputs: [{ name: "blobId", type: "bytes32", indexed: true }]
} as const;

export const registryAbi = [
  {
    type: "function", name: "createBlobNamed", stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" }, { name: "blobName", type: "string" },
      { name: "commitment", type: "bytes32" }, { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" }, { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" }, { name: "expiresAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function", name: "createBlobNamedPaid", stateMutability: "payable",
    inputs: [{ name: "registration", type: "tuple", components: [
      { name: "blobId", type: "bytes32" }, { name: "blobName", type: "string" },
      { name: "commitment", type: "bytes32" }, { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" }, { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" }, { name: "expiresAt", type: "uint64" },
      { name: "storageMode", type: "uint8" }, { name: "accessPolicy", type: "uint8" },
      { name: "policyCommitment", type: "bytes32" }, { name: "keyEnvelopeCommitment", type: "bytes32" },
      { name: "metadataCommitment", type: "bytes32" }
    ] }],
    outputs: []
  },
  {
    type: "function", name: "quoteNativePayment", stateMutability: "view",
    inputs: [
      { name: "size", type: "uint64" }, { name: "totalShards", type: "uint8" },
      { name: "storageMode", type: "uint8" }, { name: "expiresAt", type: "uint64" }
    ],
    outputs: [
      { name: "total", type: "uint256" }, { name: "providerPool", type: "uint256" },
      { name: "protocolFee", type: "uint256" }, { name: "providerRewardPerShard", type: "uint256" },
      { name: "quoteCommitment", type: "bytes32" }
    ]
  },
  {
    type: "function", name: "blobs", stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" }, { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" }, { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" }, { name: "totalShards", type: "uint8" },
      { name: "acknowledgementCount", type: "uint256" }, { name: "status", type: "uint8" },
      { name: "exists", type: "bool" }, { name: "expiresAt", type: "uint64" },
      { name: "origin", type: "uint8" }
    ]
  },
  {
    type: "function", name: "blobNames", stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{ name: "blobName", type: "string" }]
  },
  {
    type: "function", name: "blobIdByOwnerNameHash", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "nameHash", type: "bytes32" }],
    outputs: [{ name: "blobId", type: "bytes32" }]
  },
  {
    type: "function", name: "getBlobPolicy", stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{ name: "policy", type: "tuple", components: [
      { name: "storageMode", type: "uint8" }, { name: "accessPolicy", type: "uint8" },
      { name: "policyCommitment", type: "bytes32" }, { name: "keyEnvelopeCommitment", type: "bytes32" },
      { name: "metadataCommitment", type: "bytes32" }
    ] }]
  },
  {
    type: "function", name: "getBlobPayment", stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{ name: "payment", type: "tuple", components: [
      { name: "asset", type: "uint8" }, { name: "status", type: "uint8" },
      { name: "payer", type: "address" }, { name: "totalPaid", type: "uint256" },
      { name: "providerPool", type: "uint256" }, { name: "providerRewardPerShard", type: "uint256" },
      { name: "protocolFee", type: "uint256" }, { name: "providerSettled", type: "uint256" },
      { name: "quoteCommitment", type: "bytes32" }, { name: "paidAt", type: "uint64" },
      { name: "settledAt", type: "uint64" }
    ] }]
  },
  {
    type: "function", name: "placement", stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }, { name: "shardIndex", type: "uint8" }],
    outputs: [{ name: "providerId", type: "uint256" }]
  },
  {
    type: "function", name: "acknowledgements", stateMutability: "view",
    inputs: [
      { name: "blobId", type: "bytes32" }, { name: "providerId", type: "uint256" },
      { name: "shardIndex", type: "uint8" }
    ],
    outputs: [
      { name: "commitment", type: "bytes32" }, { name: "size", type: "uint64" },
      { name: "acknowledgedAt", type: "uint64" }, { name: "exists", type: "bool" }
    ]
  },
  {
    type: "function", name: "providers", stateMutability: "view",
    inputs: [{ name: "providerId", type: "uint256" }],
    outputs: [
      { name: "operator", type: "address" }, { name: "endpoint", type: "string" },
      { name: "signingKey", type: "bytes32" }, { name: "active", type: "bool" },
      { name: "registeredAt", type: "uint64" }
    ]
  },
  blobFinalizedEvent,
  { type: "event", name: "BlobCreated", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "commitment", type: "bytes32", indexed: false }, { name: "size", type: "uint64", indexed: false }
  ] },
  { type: "event", name: "BlobNamed", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "nameHash", type: "bytes32", indexed: true }, { name: "blobName", type: "string", indexed: false }
  ] },
  { type: "event", name: "ShardAssigned", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "shardIndex", type: "uint8", indexed: true },
    { name: "providerId", type: "uint256", indexed: true }
  ] },
  { type: "event", name: "ShardAcknowledged", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "shardIndex", type: "uint8", indexed: true },
    { name: "providerId", type: "uint256", indexed: true }, { name: "commitment", type: "bytes32", indexed: false },
    { name: "size", type: "uint64", indexed: false }
  ] },
  { type: "event", name: "RecoveryStarted", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "providerId", type: "uint256", indexed: true },
    { name: "shardIndex", type: "uint8", indexed: true }
  ] },
  { type: "event", name: "ShardRebuilt", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "shardIndex", type: "uint8", indexed: true },
    { name: "providerId", type: "uint256", indexed: true }, { name: "commitment", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "BlobPolicyRecorded", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "storageMode", type: "uint8", indexed: false },
    { name: "accessPolicy", type: "uint8", indexed: false }, { name: "policyCommitment", type: "bytes32", indexed: false },
    { name: "keyEnvelopeCommitment", type: "bytes32", indexed: false }, { name: "metadataCommitment", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "PaymentEscrowed", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "payer", type: "address", indexed: true },
    { name: "asset", type: "uint8", indexed: false }, { name: "amount", type: "uint256", indexed: false },
    { name: "providerPool", type: "uint256", indexed: false }, { name: "protocolFee", type: "uint256", indexed: false },
    { name: "quoteCommitment", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "ProviderRegistered", anonymous: false, inputs: [
    { name: "providerId", type: "uint256", indexed: true }, { name: "operator", type: "address", indexed: true },
    { name: "endpoint", type: "string", indexed: false }, { name: "signingKey", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "ProviderStatusChanged", anonymous: false, inputs: [
    { name: "providerId", type: "uint256", indexed: true }, { name: "active", type: "bool", indexed: false }
  ] },
  { type: "event", name: "ProviderSettlementClaimed", anonymous: false, inputs: [
    { name: "blobId", type: "bytes32", indexed: true }, { name: "providerId", type: "uint256", indexed: true },
    { name: "operator", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }
  ] }
] as const;

export const coston2 = {
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_COSTON2_RPC_URL || "https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" } }
} as const;
