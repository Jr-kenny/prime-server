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
    name: "createBlobPaid",
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
    name: "createOperatorBlob",
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
    name: "createOperatorBlobNamed",
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
    name: "setConfidentialAccessController",
    stateMutability: "nonpayable",
    inputs: [
      { name: "controller", type: "address" },
      { name: "allowed", type: "bool" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "setBlobWalletAccess",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "wallet", type: "address" },
      { name: "allowed", type: "bool" }
    ],
    outputs: []
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
  },
  {
    type: "function",
    name: "confidentialAccessRequests",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [{ name: "request", type: "tuple", components: [
      { name: "blobId", type: "bytes32" },
      { name: "requester", type: "address" },
      { name: "deviceKeyCommitment", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "purpose", type: "uint8" },
      { name: "exists", type: "bool" },
      { name: "consumed", type: "bool" }
    ] }]
  },
  {
    type: "function",
    name: "isConfidentialAccessUsable",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [{ name: "usable", type: "bool" }]
  },
  {
    type: "function",
    name: "recordConfidentialAccessResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "responseCommitment", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "getBlobPolicy",
    stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{
      name: "policy",
      type: "tuple",
      components: [
        { name: "storageMode", type: "uint8" },
        { name: "accessPolicy", type: "uint8" },
        { name: "policyCommitment", type: "bytes32" },
        { name: "keyEnvelopeCommitment", type: "bytes32" },
        { name: "metadataCommitment", type: "bytes32" }
      ]
    }]
  },
  {
    type: "function",
    name: "getBlobPayment",
    stateMutability: "view",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: [{
      name: "payment",
      type: "tuple",
      components: [
        { name: "asset", type: "uint8" },
        { name: "status", type: "uint8" },
        { name: "payer", type: "address" },
        { name: "totalPaid", type: "uint256" },
        { name: "providerPool", type: "uint256" },
        { name: "providerRewardPerShard", type: "uint256" },
        { name: "protocolFee", type: "uint256" },
        { name: "providerSettled", type: "uint256" },
        { name: "quoteCommitment", type: "bytes32" },
        { name: "paidAt", type: "uint64" },
        { name: "settledAt", type: "uint64" }
      ]
    }]
  },
  {
    type: "function",
    name: "claimProviderSettlement",
    stateMutability: "nonpayable",
    inputs: [
      { name: "blobId", type: "bytes32" },
      { name: "shardIndices", type: "uint8[]" }
    ],
    outputs: [{ name: "amount", type: "uint256" }]
  },
  {
    type: "function",
    name: "refundPaidBlob",
    stateMutability: "nonpayable",
    inputs: [{ name: "blobId", type: "bytes32" }],
    outputs: []
  },
  {
    type: "function",
    name: "withdrawProtocolFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" }
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
      { name: "expiresAt", type: "uint64" },
      { name: "origin", type: "uint8" }
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
  },
  {
    type: "event",
    name: "BlobPolicyRecorded",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "storageMode", type: "uint8", indexed: false },
      { name: "accessPolicy", type: "uint8", indexed: false },
      { name: "policyCommitment", type: "bytes32", indexed: false },
      { name: "keyEnvelopeCommitment", type: "bytes32", indexed: false },
      { name: "metadataCommitment", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "PaymentEscrowed",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "asset", type: "uint8", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "providerPool", type: "uint256", indexed: false },
      { name: "protocolFee", type: "uint256", indexed: false },
      { name: "quoteCommitment", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ProviderSettlementClaimed",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "providerId", type: "uint256", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "PaymentRefunded",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ProtocolFeesWithdrawn",
    anonymous: false,
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false }
    ]
  },
  {
    type: "event",
    name: "NativePricingChanged",
    anonymous: false,
    inputs: [
      { name: "ratePerMiBPerShard", type: "uint256", indexed: false },
      { name: "protocolFeeBps", type: "uint16", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ConfidentialAccessControllerChanged",
    anonymous: false,
    inputs: [
      { name: "controller", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false }
    ]
  },
  {
    type: "event",
    name: "BlobWalletAccessChanged",
    anonymous: false,
    inputs: [
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ConfidentialAccessAuthorized",
    anonymous: false,
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "deviceKeyCommitment", type: "bytes32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
      { name: "purpose", type: "uint8", indexed: false }
    ]
  },
  {
    type: "event",
    name: "ConfidentialAccessConsumed",
    anonymous: false,
    inputs: [
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "blobId", type: "bytes32", indexed: true },
      { name: "responseCommitment", type: "bytes32", indexed: false }
    ]
  }
];
