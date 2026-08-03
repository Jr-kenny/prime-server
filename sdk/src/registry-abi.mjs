export const primeServerRegistryAbi = [
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
    name: "createBlobNamedPaid",
    stateMutability: "payable",
    inputs: [{
      name: "registration",
      type: "tuple",
      components: [
        { name: "blobId", type: "bytes32" },
        { name: "blobName", type: "string" },
        { name: "commitment", type: "bytes32" },
        { name: "size", type: "uint64" },
        { name: "chunkSize", type: "uint32" },
        { name: "dataShards", type: "uint8" },
        { name: "totalShards", type: "uint8" },
        { name: "expiresAt", type: "uint64" },
        { name: "storageMode", type: "uint8" },
        { name: "accessPolicy", type: "uint8" },
        { name: "policyCommitment", type: "bytes32" },
        { name: "keyEnvelopeCommitment", type: "bytes32" },
        { name: "metadataCommitment", type: "bytes32" }
      ]
    }],
    outputs: []
  },
  {
    type: "function",
    name: "quoteNativePayment",
    stateMutability: "view",
    inputs: [
      { name: "size", type: "uint64" },
      { name: "totalShards", type: "uint8" },
      { name: "storageMode", type: "uint8" }
    ],
    outputs: [
      { name: "total", type: "uint256" },
      { name: "providerPool", type: "uint256" },
      { name: "protocolFee", type: "uint256" },
      { name: "providerRewardPerShard", type: "uint256" },
      { name: "quoteCommitment", type: "bytes32" }
    ]
  },
  {
    type: "function",
    name: "confidentialAccessNonces",
    stateMutability: "view",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "requester", type: "address" }
    ],
    outputs: [{ name: "nonce", type: "uint256" }]
  },
  {
    type: "function",
    name: "hashConfidentialAccess",
    stateMutability: "view",
    inputs: [{ name: "request", type: "tuple", components: [
      { name: "blobId", type: "bytes32" },
      { name: "requester", type: "address" },
      { name: "deviceKeyCommitment", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "purpose", type: "uint8" },
      { name: "exists", type: "bool" },
      { name: "consumed", type: "bool" }
    ] }],
    outputs: [{ name: "digest", type: "bytes32" }]
  },
  {
    type: "function",
    name: "authorizeConfidentialAccess",
    stateMutability: "nonpayable",
    inputs: [
      { name: "request", type: "tuple", components: [
        { name: "blobId", type: "bytes32" },
        { name: "requester", type: "address" },
        { name: "deviceKeyCommitment", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "purpose", type: "uint8" },
        { name: "exists", type: "bool" },
        { name: "consumed", type: "bool" }
      ] },
      { name: "signature", type: "bytes" }
    ],
    outputs: [{ name: "requestId", type: "bytes32" }]
  }
];
