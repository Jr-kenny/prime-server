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
      { name: "exists", type: "bool" }
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
  }
];
