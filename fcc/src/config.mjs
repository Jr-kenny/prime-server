function bytes32Ascii(value) {
  const encoded = Buffer.from(value, "utf8").toString("hex");
  if (encoded.length > 64) throw new Error("FCC operation name exceeds bytes32");
  return `0x${encoded.padEnd(64, "0")}`;
}

export const OP_TYPE_PRIME_SERVER_NAME = "PRIME_SERVER";
export const OP_COMMAND_KEY_REWRAP_NAME = "KEY_REWRAP";
export const OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME = "COMPUTE";
export const OP_TYPE_PRIME_SERVER = bytes32Ascii(OP_TYPE_PRIME_SERVER_NAME);
export const OP_COMMAND_KEY_REWRAP = bytes32Ascii(OP_COMMAND_KEY_REWRAP_NAME);
export const OP_COMMAND_CONFIDENTIAL_COMPUTE = bytes32Ascii(OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME);

export const KEY_REWRAP_TYPES = [
  { type: "bytes32", name: "requestId" },
  { type: "bytes32", name: "blobId" },
  { type: "address", name: "blobOwner" },
  { type: "address", name: "requester" },
  { type: "bytes32", name: "deviceKeyCommitment" },
  { type: "bytes32", name: "keyEnvelopeCommitment" },
  { type: "bytes", name: "devicePublicKey" },
  { type: "bytes", name: "keyEnvelope" }
];

export const CONFIDENTIAL_COMPUTE_TYPES = [
  { type: "bytes32", name: "requestId" },
  { type: "bytes32", name: "blobId" },
  { type: "address", name: "blobOwner" },
  { type: "address", name: "requester" },
  { type: "bytes32", name: "keyEnvelopeCommitment" },
  { type: "bytes", name: "keyEnvelope" },
  { type: "bytes", name: "computeSpec" },
  { type: "bytes32", name: "inputCommitment" }
];
