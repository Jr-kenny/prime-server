import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, randomBytes } from "node:crypto";
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

function concatKdf(sharedSecret, outputBytes) {
  const output = [];
  for (let counter = 1; Buffer.concat(output).length < outputBytes; counter += 1) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter, 0);
    output.push(createHash("sha256").update(counterBytes).update(sharedSecret).digest());
  }
  return Buffer.concat(output).subarray(0, outputBytes);
}

/**
 * Encrypts bytes using the ECIES profile implemented by Flare's tee-node:
 * secp256k1, AES-128-CTR, SHA-256 concatenation KDF, and HMAC-SHA256.
 * The returned bytes are accepted by the official TEE /decrypt endpoint.
 */
export function encryptForFlareTee(plaintext, publicKey) {
  const recipient = bytes(publicKey, "fccPublicKey");
  if (recipient.length !== 33 && recipient.length !== 65) {
    throw new Error("fccPublicKey must be a compressed or uncompressed secp256k1 public key");
  }
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const sharedSecret = ephemeral.computeSecret(recipient);
  const derived = concatKdf(sharedSecret, 32);
  const encryptionKey = derived.subarray(0, 16);
  const macKey = createHash("sha256").update(derived.subarray(16)).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-ctr", encryptionKey, iv);
  const encrypted = Buffer.concat([iv, cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = createHmac("sha256", macKey).update(encrypted).digest();
  return Buffer.concat([ephemeral.getPublicKey(undefined, "uncompressed"), encrypted, tag]);
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

function sealForFcc(
  fileKey,
  { fccPublicKey, blobId, owner, storageMode, accessPolicy, metadata, metadataCommitment, envelopeScheme } = {}
) {
  const recipient = bytes(fccPublicKey, "fccPublicKey");
  if (recipient.length !== 33 && recipient.length !== 65) throw new Error("fccPublicKey must be a compressed or uncompressed secp256k1 public key");
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
  if (envelopeScheme === "flare-tee-ecies") {
    return {
      version: 1,
      scheme: "flare-tee-ecies-aes128ctr-hmacsha256",
      blobId,
      owner,
      storageMode,
      accessPolicy,
      recipientPublicKey: hex(recipient),
      ciphertext: hex(encryptForFlareTee(payload, recipient)),
      fileKeyCommitment: sha256(fileKey)
    };
  }
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const sharedSecret = ephemeral.computeSecret(recipient);
  const wrappingKey = createHash("sha256").update(sharedSecret).digest();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
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

export function openDeviceKeyPackage(input, devicePrivateKey) {
  const keyPackage = typeof input === "string" ? JSON.parse(input) : input;
  if (!keyPackage || keyPackage.scheme !== "secp256k1-ecies-aes256gcm-device") {
    throw new Error("unsupported device key package scheme");
  }
  const privateKey = Buffer.isBuffer(devicePrivateKey)
    ? Buffer.from(devicePrivateKey)
    : bytes(devicePrivateKey, "devicePrivateKey");
  if (privateKey.length !== 32) throw new Error("devicePrivateKey must be 32 bytes");

  const device = createECDH("secp256k1");
  device.setPrivateKey(privateKey);
  const expectedDeviceCommitment = deviceKeyCommitment(device.getPublicKey());
  if (expectedDeviceCommitment.toLowerCase() !== String(keyPackage.deviceKeyCommitment).toLowerCase()) {
    throw new Error("device key package is bound to another device");
  }

  const ephemeralPublicKey = bytes(keyPackage.ephemeralPublicKey, "keyPackage.ephemeralPublicKey");
  const wrappingKey = createHash("sha256").update(device.computeSecret(ephemeralPublicKey)).digest();
  const iv = bytes(keyPackage.iv, "keyPackage.iv");
  const authTag = bytes(keyPackage.authTag, "keyPackage.authTag");
  const ciphertext = bytes(keyPackage.ciphertext, "keyPackage.ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
  decipher.setAuthTag(authTag);
  const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));

  if (String(payload.requestId).toLowerCase() !== String(keyPackage.requestId).toLowerCase()) {
    throw new Error("device key package request binding mismatch");
  }
  if (String(payload.blobId).toLowerCase() !== String(keyPackage.blobId).toLowerCase()) {
    throw new Error("device key package blob binding mismatch");
  }
  if (String(payload.deviceKeyCommitment).toLowerCase() !== String(keyPackage.deviceKeyCommitment).toLowerCase()) {
    throw new Error("device key package commitment binding mismatch");
  }
  const fileKey = bytes(payload.fileKey, "device key package fileKey");
  if (fileKey.length !== AES_KEY_BYTES) throw new Error("device key package fileKey must be 32 bytes");
  if (sha256(fileKey).toLowerCase() !== String(keyPackage.fileKeyCommitment).toLowerCase()) {
    throw new Error("device key package file-key commitment mismatch");
  }
  return fileKey;
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
  blobId = hex(randomBytes(32)),
  envelopeScheme
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
    metadataCommitment: resolvedMetadataCommitment,
    envelopeScheme
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
