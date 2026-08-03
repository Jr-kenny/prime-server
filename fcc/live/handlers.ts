import { createCipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import { decodeAbiParameters } from "viem";
import type { Framework, HandlerResult } from "../../../fce-extension-scaffold/typescript/src/base/types.js";

import { OP_COMMAND_KEY_REWRAP, OP_TYPE_PRIME_SERVER } from "./config.js";

const KEY_REWRAP_TYPES = [
  { type: "bytes32", name: "requestId" },
  { type: "bytes32", name: "blobId" },
  { type: "address", name: "blobOwner" },
  { type: "address", name: "requester" },
  { type: "bytes32", name: "deviceKeyCommitment" },
  { type: "bytes32", name: "keyEnvelopeCommitment" },
  { type: "bytes", name: "devicePublicKey" },
  { type: "bytes", name: "keyEnvelope" }
] as const;

function bytes(value: string, field: string): Buffer {
  const normalized = String(value || "").replace(/^0x/, "");
  if (!normalized || normalized.length % 2 || !/^[a-fA-F0-9]+$/.test(normalized)) {
    throw new Error(`${field} must be hex bytes`);
  }
  return Buffer.from(normalized, "hex");
}

function hex(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: Uint8Array): string {
  return hex(createHash("sha256").update(value).digest());
}

function addressEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, "");
}

function decodeMessage(message: string) {
  if (!/^0x[0-9a-fA-F]*$/.test(message)) throw new Error("FCC message must be hex");
  const [requestId, blobId, blobOwner, requester, deviceKeyCommitment, keyEnvelopeCommitment, devicePublicKey, keyEnvelope] =
    decodeAbiParameters(KEY_REWRAP_TYPES, message as `0x${string}`);
  return {
    requestId,
    blobId,
    blobOwner,
    requester,
    deviceKeyCommitment,
    keyEnvelopeCommitment,
    devicePublicKey: Buffer.from(devicePublicKey.slice(2), "hex"),
    keyEnvelope: JSON.parse(Buffer.from(keyEnvelope.slice(2), "hex").toString("utf8")) as Record<string, unknown>
  };
}

async function decryptWithTeeNode(ciphertext: Buffer): Promise<Buffer> {
  const signPort = process.env.SIGN_PORT ?? "7701";
  const response = await fetch(`http://localhost:${signPort}/decrypt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encryptedMessage: ciphertext.toString("base64") })
  });
  if (!response.ok) throw new Error(`TEE decrypt failed with ${response.status}`);
  const body = await response.json() as { decryptedMessage?: string };
  if (!body.decryptedMessage) throw new Error("TEE decrypt response missing plaintext");
  return Buffer.from(body.decryptedMessage, "base64");
}

function wrapFileKeyForDevice(fileKey: Buffer, devicePublicKey: Buffer, requestId: string, blobId: string, deviceKeyCommitment: string) {
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const wrappingKey = createHash("sha256").update(ephemeral.computeSecret(devicePublicKey)).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const payload = Buffer.from(canonicalJson({
    version: 1,
    requestId,
    blobId,
    deviceKeyCommitment,
    fileKey: hex(fileKey)
  }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    version: 1,
    scheme: "secp256k1-ecies-aes256gcm-device",
    requestId,
    blobId,
    deviceKeyCommitment,
    ephemeralPublicKey: hex(ephemeral.getPublicKey(undefined, "uncompressed")),
    iv: hex(iv),
    ciphertext: hex(ciphertext),
    authTag: hex(cipher.getAuthTag()),
    fileKeyCommitment: sha256(fileKey)
  };
}

async function handleKeyRewrap(message: string): Promise<HandlerResult> {
  try {
    const decoded = decodeMessage(message);
    const envelopeCommitment = sha256(Buffer.from(canonicalJson(decoded.keyEnvelope)));
    if (envelopeCommitment.toLowerCase() !== decoded.keyEnvelopeCommitment.toLowerCase()) {
      throw new Error("key envelope commitment mismatch");
    }
    if (sha256(decoded.devicePublicKey).toLowerCase() !== decoded.deviceKeyCommitment.toLowerCase()) {
      throw new Error("device key commitment mismatch");
    }
    if (decoded.keyEnvelope.scheme !== "flare-tee-ecies-aes128ctr-hmacsha256") {
      throw new Error("official FCC envelope scheme required");
    }

    const envelopePayload = JSON.parse(
      (await decryptWithTeeNode(bytes(String(decoded.keyEnvelope.ciphertext), "keyEnvelope.ciphertext"))).toString("utf8")
    ) as Record<string, unknown>;
    if (normalizeHex(String(envelopePayload.blobId)) !== normalizeHex(decoded.blobId)) throw new Error("envelope blob binding mismatch");
    if (!addressEqual(String(envelopePayload.owner), decoded.blobOwner)) throw new Error("envelope owner binding mismatch");
    if (Number(envelopePayload.storageMode) !== 1) throw new Error("private storage mode required");
    if (![0, 1].includes(Number(envelopePayload.accessPolicy))) throw new Error("private access policy required");
    const fileKey = bytes(String(envelopePayload.fileKey), "envelope.fileKey");
    if (fileKey.length !== 32) throw new Error("FCC file key must be 32 bytes");
    if (String(envelopePayload.fileKeyCommitment).toLowerCase() !== sha256(fileKey).toLowerCase()) {
      throw new Error("file-key commitment mismatch");
    }

    const keyPackage = wrapFileKeyForDevice(
      fileKey,
      decoded.devicePublicKey,
      decoded.requestId,
      decoded.blobId,
      decoded.deviceKeyCommitment
    );
    return [hex(Buffer.from(canonicalJson(keyPackage))), 1, null];
  } catch (error) {
    return [null, 0, error instanceof Error ? error.message : String(error)];
  }
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_PRIME_SERVER, OP_COMMAND_KEY_REWRAP, handleKeyRewrap);
}

export function reportState(): unknown {
  return { operation: OP_COMMAND_KEY_REWRAP, resultData: "device-wrapped-file-key-package" };
}
