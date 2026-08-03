import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function toBuffer(value, field) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  const normalized = String(value || "").replace(/^0x/, "");
  if (!normalized || normalized.length % 2 || !/^[a-fA-F0-9]+$/.test(normalized)) {
    throw new Error(`${field} must be hex bytes`);
  }
  return Buffer.from(normalized, "hex");
}

function hex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Hex(value) {
  return hex(createHash("sha256").update(toBuffer(value, "value")).digest());
}

function deriveWrappingKey(privateKey, publicKey) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(toBuffer(privateKey, "privateKey"));
  return createHash("sha256").update(ecdh.computeSecret(toBuffer(publicKey, "publicKey"))).digest();
}

function encryptPayload(payload, wrappingKey) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(payload))), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptPayload(ciphertext, iv, authTag, wrappingKey) {
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, toBuffer(iv, "iv"));
  decipher.setAuthTag(toBuffer(authTag, "authTag"));
  return JSON.parse(Buffer.concat([
    decipher.update(toBuffer(ciphertext, "ciphertext")),
    decipher.final()
  ]).toString("utf8"));
}

export function openKeyEnvelope(envelope, teePrivateKey) {
  const wrappingKey = deriveWrappingKey(teePrivateKey, envelope.ephemeralPublicKey);
  const payload = decryptPayload(envelope.ciphertext, envelope.iv, envelope.authTag, wrappingKey);
  const fileKey = toBuffer(payload.fileKey, "fileKey");
  if (fileKey.length !== 32) throw new Error("FCC envelope file key must be 32 bytes");
  if (String(envelope.fileKeyCommitment).toLowerCase() !== sha256Hex(fileKey).toLowerCase()) {
    throw new Error("FCC envelope file-key commitment mismatch");
  }
  return { payload, fileKey };
}

export function wrapFileKeyForDevice(fileKey, devicePublicKey, { requestId, blobId, deviceKeyCommitment } = {}) {
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const wrappingKey = deriveWrappingKey(ephemeral.getPrivateKey(), devicePublicKey);
  const encrypted = encryptPayload({
    version: 1,
    requestId,
    blobId,
    deviceKeyCommitment,
    fileKey: hex(fileKey)
  }, wrappingKey);
  return {
    version: 1,
    scheme: "secp256k1-ecies-aes256gcm-device",
    requestId,
    blobId,
    deviceKeyCommitment,
    ephemeralPublicKey: hex(ephemeral.getPublicKey()),
    iv: hex(encrypted.iv),
    ciphertext: hex(encrypted.ciphertext),
    authTag: hex(encrypted.authTag),
    fileKeyCommitment: sha256Hex(fileKey)
  };
}

export function openDeviceKeyPackage(keyPackage, devicePrivateKey) {
  const wrappingKey = deriveWrappingKey(devicePrivateKey, keyPackage.ephemeralPublicKey);
  const payload = decryptPayload(keyPackage.ciphertext, keyPackage.iv, keyPackage.authTag, wrappingKey);
  const fileKey = toBuffer(payload.fileKey, "fileKey");
  if (fileKey.length !== 32) throw new Error("device key package file key must be 32 bytes");
  if (String(keyPackage.fileKeyCommitment).toLowerCase() !== sha256Hex(fileKey).toLowerCase()) {
    throw new Error("device key package commitment mismatch");
  }
  return { payload, fileKey };
}

export function decryptStoredCiphertext(ciphertext, fileKey) {
  const encrypted = toBuffer(ciphertext, "ciphertext");
  const key = toBuffer(fileKey, "fileKey");
  if (key.length !== 32) throw new Error("file key must be 32 bytes");
  if (encrypted.length <= IV_BYTES + TAG_BYTES) throw new Error("encrypted blob is truncated");
  const iv = encrypted.subarray(0, IV_BYTES);
  const authTag = encrypted.subarray(encrypted.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]);
}

export function parseJsonBytes(value, field) {
  try {
    return JSON.parse(toBuffer(value, field).toString("utf8"));
  } catch (error) {
    throw new Error(`${field} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function bytes(value, field) {
  return toBuffer(value, field);
}

export function bytesHex(value) {
  return hex(value);
}
