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
  }
];
