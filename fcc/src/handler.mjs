import { decodeAbiParameters } from "viem";
import {
  CONFIDENTIAL_COMPUTE_TYPES,
  KEY_REWRAP_TYPES,
  OP_COMMAND_CONFIDENTIAL_COMPUTE,
  OP_COMMAND_KEY_REWRAP,
  OP_TYPE_PRIME_SERVER
} from "./config.mjs";
import {
  bytes,
  bytesHex,
  canonicalJson,
  decryptStoredCiphertext,
  openKeyEnvelope,
  parseJsonBytes,
  sha256Hex,
  wrapFileKeyForDevice
} from "./crypto.mjs";

function normalizeHex(value) {
  return String(value || "").toLowerCase().replace(/^0x/, "");
}

function addressEqual(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function decodeValues(types, message) {
  const normalized = String(message || "");
  if (!/^0x[0-9a-fA-F]*$/.test(normalized)) throw new Error("FCC instruction message must be hex");
  return decodeAbiParameters(types, normalized);
}

export function decodeKeyRewrapMessage(message) {
  const [requestId, blobId, blobOwner, requester, deviceKeyCommitment, keyEnvelopeCommitment, devicePublicKey, keyEnvelope] =
    decodeValues(KEY_REWRAP_TYPES, message);
  return {
    requestId,
    blobId,
    blobOwner,
    requester,
    deviceKeyCommitment,
    keyEnvelopeCommitment,
    devicePublicKey: bytes(devicePublicKey, "devicePublicKey"),
    keyEnvelope: parseJsonBytes(keyEnvelope, "keyEnvelope")
  };
}

export function decodeConfidentialComputeMessage(message) {
  const [requestId, blobId, blobOwner, requester, keyEnvelopeCommitment, keyEnvelope, computeSpec, inputCommitment] =
    decodeValues(CONFIDENTIAL_COMPUTE_TYPES, message);
  return {
    requestId,
    blobId,
    blobOwner,
    requester,
    keyEnvelopeCommitment,
    keyEnvelope: parseJsonBytes(keyEnvelope, "keyEnvelope"),
    computeSpec: parseJsonBytes(computeSpec, "computeSpec"),
    inputCommitment
  };
}

function validateEnvelope(envelope, expectedCommitment) {
  const actual = sha256Hex(Buffer.from(canonicalJson(envelope)));
  if (actual.toLowerCase() !== String(expectedCommitment).toLowerCase()) {
    throw new Error("FCC instruction envelope commitment mismatch");
  }
}

function validateEnvelopePayload(envelopeResult, { blobId, blobOwner, storageMode, accessPolicy }) {
  if (normalizeHex(envelopeResult.payload.blobId) !== normalizeHex(blobId)) {
    throw new Error("FCC envelope blob binding mismatch");
  }
  if (!addressEqual(envelopeResult.payload.owner, blobOwner)) {
    throw new Error("FCC envelope owner binding mismatch");
  }
  if (Number(envelopeResult.payload.storageMode) !== storageMode) {
    throw new Error("FCC envelope storage mode mismatch");
  }
  if (Number(envelopeResult.payload.accessPolicy) !== accessPolicy) {
    throw new Error("FCC envelope access policy mismatch");
  }
}

export function processKeyRewrap(message, { teePrivateKey } = {}) {
  validateEnvelope(message.keyEnvelope, message.keyEnvelopeCommitment);
  if (sha256Hex(message.devicePublicKey).toLowerCase() !== message.deviceKeyCommitment.toLowerCase()) {
    throw new Error("FCC device key commitment mismatch");
  }
  const envelope = openKeyEnvelope(message.keyEnvelope, teePrivateKey);
  const accessPolicy = Number(envelope.payload.accessPolicy);
  if (accessPolicy !== 0 && accessPolicy !== 1) throw new Error("FCC key rewrap requires private access policy");
  validateEnvelopePayload(envelope, { ...message, storageMode: 1, accessPolicy });
  const keyPackage = wrapFileKeyForDevice(envelope.fileKey, message.devicePublicKey, {
    requestId: message.requestId,
    blobId: message.blobId,
    deviceKeyCommitment: message.deviceKeyCommitment
  });
  return {
    kind: "key_rewrap",
    response: keyPackage,
    responseCommitment: sha256Hex(Buffer.from(canonicalJson(keyPackage)))
  };
}

function recordsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.records)) return value.records;
  throw new Error("compute input must be a JSON array or an object with records");
}

function executeCompute(plaintext, spec) {
  const operation = String(spec?.operation || "").toLowerCase();
  if (operation === "sha256") return { operation, result: { digest: sha256Hex(plaintext) } };
  const parsed = JSON.parse(plaintext.toString("utf8"));
  const records = recordsFromJson(parsed);
  const field = String(spec?.field || "");
  if (!field) throw new Error("compute field is required");
  if (operation === "json_field_count") {
    return { operation, result: { count: records.filter((record) => record && record[field] !== undefined).length } };
  }
  if (operation === "json_field_sum") {
    const sum = records.reduce((total, record) => {
      const value = Number(record?.[field]);
      if (!Number.isFinite(value)) throw new Error(`compute field ${field} must contain finite numbers`);
      return total + value;
    }, 0);
    return { operation, result: { sum } };
  }
  throw new Error(`unsupported confidential operation: ${operation}`);
}

export async function processConfidentialCompute(message, { teePrivateKey, retrieveCiphertext } = {}) {
  if (typeof retrieveCiphertext !== "function") throw new Error("FCC ciphertext retrieval is not configured");
  validateEnvelope(message.keyEnvelope, message.keyEnvelopeCommitment);
  const envelope = openKeyEnvelope(message.keyEnvelope, teePrivateKey);
  validateEnvelopePayload(envelope, { ...message, storageMode: 2, accessPolicy: 2 });
  const ciphertext = await retrieveCiphertext(message.blobId);
  if (sha256Hex(ciphertext).toLowerCase() !== message.inputCommitment.toLowerCase()) {
    throw new Error("FCC ciphertext commitment mismatch");
  }
  const plaintext = decryptStoredCiphertext(ciphertext, envelope.fileKey);
  const computed = executeCompute(plaintext, message.computeSpec);
  const response = {
    version: 1,
    requestId: message.requestId,
    blobId: message.blobId,
    operation: computed.operation,
    result: computed.result
  };
  return {
    kind: "confidential_compute",
    response,
    responseCommitment: sha256Hex(Buffer.from(canonicalJson(response)))
  };
}

export async function handleAction({ opType, opCommand, message, teePrivateKey, retrieveCiphertext } = {}) {
  try {
    if (String(opType).toLowerCase() !== OP_TYPE_PRIME_SERVER.toLowerCase()) {
      return [null, 0, "unsupported Prime Server FCC operation type"];
    }
    if (String(opCommand).toLowerCase() === OP_COMMAND_KEY_REWRAP.toLowerCase()) {
      const result = processKeyRewrap(decodeKeyRewrapMessage(message), { teePrivateKey });
      return [bytesHex(Buffer.from(canonicalJson({ ...result.response, responseCommitment: result.responseCommitment }))), 1, null];
    }
    if (String(opCommand).toLowerCase() === OP_COMMAND_CONFIDENTIAL_COMPUTE.toLowerCase()) {
      const result = await processConfidentialCompute(decodeConfidentialComputeMessage(message), {
        teePrivateKey,
        retrieveCiphertext
      });
      return [bytesHex(Buffer.from(canonicalJson({ ...result.response, responseCommitment: result.responseCommitment }))), 1, null];
    }
    return [null, 0, "unsupported Prime Server FCC operation command"];
  } catch (error) {
    return [null, 0, error instanceof Error ? error.message : String(error)];
  }
}
