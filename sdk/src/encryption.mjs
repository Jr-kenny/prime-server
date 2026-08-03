import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import { blobBytes, prepareBlob } from "./prepare.mjs";
import { canonicalJson, normalizePolicy, policyCommitmentFor, STORAGE_MODES, ZERO_BYTES32 } from "./policy.mjs";

const AES_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function bytes(value, field) {
  const normalized = String(value || "").replace(/^0x/, "");
  if (!normalized || normalized.length % 2 || !/^[a-fA-F0-9]+$/.test(normalized)) throw new Error(`${field} must be hex bytes`);
  return Buffer.from(normalized, "hex");
}

function sha256(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function deviceKeyCommitment(publicKey) {
  const value = Buffer.isBuffer(publicKey) ? publicKey : bytes(publicKey, "devicePublicKey");
  return sha256(value);
}

export function createDeviceKeyPair() {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey();
  return {
    publicKey: hex(publicKey),
    privateKey: Buffer.from(ecdh.getPrivateKey()),
    keyCommitment: deviceKeyCommitment(publicKey)
  };
}

function normalizeBlobId(value) {
  const blobId = String(value || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(blobId)) throw new Error("blobId must be a 32-byte hex identifier");
  return blobId.toLowerCase();
}

function normalizeOwner(value) {
  const owner = String(value || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) throw new Error("owner must be an EVM address");
  return owner.toLowerCase();
}

function sealForFcc(fileKey, { fccPublicKey, blobId, owner, storageMode, accessPolicy, metadata, metadataCommitment } = {}) {
  const recipient = bytes(fccPublicKey, "fccPublicKey");
  if (recipient.length !== 33 && recipient.length !== 65) throw new Error("fccPublicKey must be a compressed or uncompressed secp256k1 public key");
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const sharedSecret = ephemeral.computeSecret(recipient);
  const wrappingKey = createHash("sha256").update(sharedSecret).digest();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const payload = Buffer.from(canonicalJson({
    version: 1,
    blobId,
    owner,
    storageMode,
    accessPolicy,
    metadataCommitment,
    metadata,
    fileKey: hex(fileKey)
  }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    scheme: "secp256k1-ecies-aes256gcm",
    blobId,
    owner,
    storageMode,
    accessPolicy,
    recipientPublicKey: hex(recipient),
    ephemeralPublicKey: hex(ephemeral.getPublicKey()),
    iv: hex(iv),
    ciphertext: hex(ciphertext),
    authTag: hex(authTag),
    fileKeyCommitment: sha256(fileKey)
  };
}

export async function encryptBlob(input) {
  const plaintext = await blobBytes(input);
  if (plaintext.length === 0) throw new Error("blob body is required");
  const fileKey = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", fileKey, iv);
  const ciphertext = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext,
    fileKey,
    encryption: {
      version: 1,
      algorithm: "AES-256-GCM",
      format: "iv12.ciphertext.authTag16",
      iv: hex(iv),
      authTag: hex(cipher.getAuthTag())
    },
    originalSize: plaintext.length,
    ciphertextSize: ciphertext.length
  };
}

export async function decryptBlob(input, fileKey) {
  const encrypted = await blobBytes(input);
  const key = Buffer.isBuffer(fileKey) ? fileKey : bytes(fileKey, "fileKey");
  if (key.length !== AES_KEY_BYTES) throw new Error("fileKey must be 32 bytes");
  if (encrypted.length <= IV_BYTES + TAG_BYTES) throw new Error("encrypted blob is truncated");
  const iv = encrypted.subarray(0, IV_BYTES);
  const authTag = encrypted.subarray(encrypted.length - TAG_BYTES);
  const ciphertext = encrypted.subarray(IV_BYTES, encrypted.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function prepareEncryptedBlob(input, {
  name,
  owner,
  storageMode = "private",
  accessPolicy = "owner_only",
  fccPublicKey,
  metadataCommitment = ZERO_BYTES32,
  metadata,
  contentType = "application/octet-stream",
  allowedWallets = [],
  expirationSeconds,
  expiresAt = 0,
  blobId = hex(randomBytes(32))
} = {}) {
  if (!name) throw new Error("name is required for encrypted metadata");
  const resolvedBlobId = normalizeBlobId(blobId);
  const resolvedOwner = normalizeOwner(owner);
  const encrypted = await encryptBlob(input);
  const mode = typeof storageMode === "string" ? storageMode.toLowerCase().replace(/-/g, "_") : Number(storageMode);
  if (mode === STORAGE_MODES.public || mode === "public") throw new Error("encrypted preparation requires private or confidential storage");
  const metadataValue = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...metadata, filename: metadata.filename || name, contentType: metadata.contentType || contentType }
    : { value: metadata ?? null, filename: name, contentType };
  const computedMetadataCommitment = sha256(Buffer.from(canonicalJson(metadataValue)));
  if (metadataCommitment !== ZERO_BYTES32 && String(metadataCommitment).toLowerCase() !== computedMetadataCommitment) {
    throw new Error("metadataCommitment does not match the encrypted metadata");
  }
  const resolvedMetadataCommitment = computedMetadataCommitment;
  const preliminaryPolicy = normalizePolicy({ storageMode, accessPolicy, keyEnvelopeCommitment: `0x${"01".padStart(64, "0")}`, metadataCommitment: resolvedMetadataCommitment, allowedWallets });
  const keyEnvelope = sealForFcc(encrypted.fileKey, {
    fccPublicKey,
    blobId: resolvedBlobId,
    owner: resolvedOwner,
    storageMode: preliminaryPolicy.storageMode,
    accessPolicy: preliminaryPolicy.accessPolicy,
    metadata: metadataValue,
    metadataCommitment: resolvedMetadataCommitment
  });
  const keyEnvelopeCommitment = sha256(Buffer.from(canonicalJson(keyEnvelope)));
  const policy = normalizePolicy({
    storageMode,
    accessPolicy,
    keyEnvelopeCommitment,
    metadataCommitment: resolvedMetadataCommitment,
    allowedWallets
  });
  const prepared = await prepareBlob(encrypted.ciphertext, {
    name: `private/${resolvedBlobId.slice(2)}`,
    expirationSeconds,
    expiresAt,
    blobId: resolvedBlobId
  });
  return {
    ...prepared,
    ciphertext: Buffer.from(encrypted.ciphertext),
    originalSize: encrypted.originalSize,
    encryption: encrypted.encryption,
    fileKey: Buffer.from(encrypted.fileKey),
    keyEnvelope,
    keyEnvelopeCommitment,
    metadataCommitment: resolvedMetadataCommitment,
    policy
  };
}

export function keyEnvelopeCommitment(envelope) {
  return sha256(Buffer.from(canonicalJson(envelope)));
}

export { policyCommitmentFor };
