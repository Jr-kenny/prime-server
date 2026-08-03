export const primeServerRegistryAbi = [
  {
    type: "function",
    name: "registerProvider",
    stateMutability: "nonpayable",
    inputs: [
      { name: "endpoint", type: "string" },
      { name: "signingKey", type: "bytes32" }
    ],
    outputs: [{ name: "providerId", type: "uint256" }]
  },
  {
    type: "function",
    name: "providerIdByOperator",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ name: "providerId", type: "uint256" }]
  },
  {
    type: "function",
    name: "createBlob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "createBlobWithExpiry",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" },
      { name: "expiresAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "createBlobNamed",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "blobName", type: "string" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" },
      { name: "expiresAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "createBlobFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "blobId", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" },
      { name: "expiresAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "createBlobForNamed",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "blobId", type: "bytes32" },
      { name: "blobName", type: "string" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" },
      { name: "expiresAt", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "blobNameHashes",
    stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{ name: "nameHash", type: "bytes32" }]
  },
  {
    type: "function",
    name: "blobNames",
    stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{ name: "blobName", type: "string" }]
  },
  {
    type: "function",
    name: "blobIdByOwnerNameHash",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "nameHash", type: "bytes32" }
    ],
    outputs: [{ name: "blobId", type: "bytes32" }]
  },
  {
    type: "function",
    name: "assignShard",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" },
      { name: "providerId", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "acknowledgeShard",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" },
      { name: "shardCommitment", type: "bytes32" },
      { name: "shardSize", type: "uint64" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "finalizeBlob",
    stateMutability: "nonpayable",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: []
  },
  {
    type: "function",
    name: "startRecovery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "reassignShard",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" },
      { name: "providerId", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "recordRebuiltShard",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" },
      { name: "providerId", type: "uint256" },
      { name: "shardCommitment", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "blobs",
    stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "chunkSize", type: "uint32" },
      { name: "dataShards", type: "uint8" },
      { name: "totalShards", type: "uint8" },
      { name: "acknowledgementCount", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "exists", type: "bool" },
      { name: "expiresAt", type: "uint64" }
    ]
  },
  {
    type: "function",
    name: "placement",
    stateMutability: "view",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndex", type: "uint8" }
    ],
    outputs: [{ name: "providerId", type: "uint256" }]
  },
  {
    type: "function",
    name: "acknowledgements",
    stateMutability: "view",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "providerId", type: "uint256" },
      { name: "shardIndex", type: "uint8" }
    ],
    outputs: [
      { name: "commitment", type: "bytes32" },
      { name: "size", type: "uint64" },
      { name: "acknowledgedAt", type: "uint64" },
      { name: "exists", type: "bool" }
    ]
  },
  {
    type: "event",
    name: "ProviderRegistered",
    anonymous: false,
    inputs: [
      { name: "providerId", type: "uint256", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "endpoint", type: "string", indexed: false },
      { name: "signingKey", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ProviderStatusChanged",
    anonymous: false,
    inputs: [
      { name: "providerId", type: "uint256", indexed: true },
      { name: "active", type: "bool", indexed: false }
    ]
  },
  {
    type: "event",
    name: "BlobCreated",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "size", type: "uint64", indexed: false }
    ]
  },
  {
    type: "event",
    name: "BlobNamed",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "nameHash", type: "bytes32", indexed: true },
      { name: "blobName", type: "string", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ShardAssigned",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "shardIndex", type: "uint8", indexed: true },
      { name: "providerId", type: "uint256", indexed: true }
    ]
  },
  {
    type: "event",
    name: "ShardAcknowledged",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "shardIndex", type: "uint8", indexed: true },
      { name: "providerId", type: "uint256", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "size", type: "uint64", indexed: false }
    ]
  },
  {
    type: "event",
    name: "BlobFinalized",
    anonymous: false,
    inputs: [{ name: "blobId", type: "bytes32", indexed: true }]
  },
  {
    type: "event",
    name: "RecoveryStarted",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "providerId", type: "uint256", indexed: true },
      { name: "shardIndex", type: "uint8", indexed: true }
    ]
  },
  {
    type: "event",
    name: "ShardRebuilt",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "shardIndex", type: "uint8", indexed: true },
      { name: "providerId", type: "uint256", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false }
    ]
  }
];
