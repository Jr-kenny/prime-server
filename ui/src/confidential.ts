import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "viem";
import { prepareBytes, type PreparedBlob } from "./prime";

export type ConfidentialPolicy = {
  storageMode: 2;
  accessPolicy: 2;
  policyCommitment: `0x${string}`;
  keyEnvelopeCommitment: `0x${string}`;
  metadataCommitment: `0x${string}`;
};

export type PreparedConfidentialBlob = PreparedBlob & {
  ciphertext: Uint8Array;
  originalSize: number;
  keyEnvelope: Record<string, unknown>;
  keyEnvelopeCommitment: `0x${string}`;
  metadataCommitment: `0x${string}`;
  policy: ConfidentialPolicy;
  contentType: string;
};

function hex(value: Uint8Array): `0x${string}` {
  return bytesToHex(value) as `0x${string}`;
}

function bytes(value: string): Uint8Array {
  return hexToBytes(value as `0x${string}`);
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: Uint8Array | string): `0x${string}` {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(sha256(input));
}

function concatKdf(sharedSecret: Uint8Array, outputBytes: number): Uint8Array {
  const output: Uint8Array[] = [];
  for (let counter = 1; output.reduce((total, item) => total + item.length, 0) < outputBytes; counter += 1) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter);
    output.push(sha256(concat(counterBytes, sharedSecret)));
  }
  return concat(...output).slice(0, outputBytes);
}

async function encryptAesGcm(plaintext: Uint8Array, fileKey: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", arrayBuffer(fileKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer(plaintext)));
  return concat(iv, encrypted);
}

async function encryptForFlareTee(plaintext: Uint8Array, publicKey: string): Promise<Uint8Array> {
  const recipient = bytes(publicKey);
  if (recipient.length !== 33 && recipient.length !== 65) throw new Error("FCC public key must be a compressed or uncompressed secp256k1 key");
  const ephemeralPrivateKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralPrivateKey, false);
  const sharedSecret = secp256k1.getSharedSecret(ephemeralPrivateKey, recipient, false).slice(1, 33);
  const derived = concatKdf(sharedSecret, 32);
  const encryptionKey = derived.slice(0, 16);
  const macKey = sha256(derived.slice(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", arrayBuffer(encryptionKey), { name: "AES-CTR" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 128 }, key, arrayBuffer(plaintext)));
  const framed = concat(iv, encrypted);
  return concat(ephemeralPublicKey, framed, hmac(sha256, macKey, framed));
}

export async function prepareConfidentialFile(
  file: File,
  { owner, fccPublicKey, expiresAt, name }: { owner: string; fccPublicKey: string; expiresAt: number; name?: string }
): Promise<PreparedConfidentialBlob> {
  const plaintext = new Uint8Array(await file.arrayBuffer());
  if (!plaintext.length) throw new Error("The file is empty");
  const fileKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await encryptAesGcm(plaintext, fileKey);
  const blobId = hex(crypto.getRandomValues(new Uint8Array(32)));
  const normalizedFccPublicKey = hex(bytes(fccPublicKey));
  const metadata = {
    contentType: file.type || "application/octet-stream",
    filename: file.name
  };
  const metadataCommitment = digest(canonicalJson(metadata));
  const keyEnvelopePayload = {
    accessPolicy: 2,
    blobId: blobId.toLowerCase(),
    fileKey: hex(fileKey),
    metadata,
    metadataCommitment,
    owner: owner.toLowerCase(),
    storageMode: 2,
    version: 1
  };
  const sealedPayload = await encryptForFlareTee(new TextEncoder().encode(canonicalJson(keyEnvelopePayload)), normalizedFccPublicKey);
  const keyEnvelope = {
    accessPolicy: 2,
    blobId: blobId.toLowerCase(),
    ciphertext: hex(sealedPayload),
    fileKeyCommitment: digest(fileKey),
    owner: owner.toLowerCase(),
    recipientPublicKey: normalizedFccPublicKey,
    scheme: "flare-tee-ecies-aes128ctr-hmacsha256",
    storageMode: 2,
    version: 1
  };
  const keyEnvelopeCommitment = digest(canonicalJson(keyEnvelope));
  const policyCommitment = digest(canonicalJson({
    accessPolicy: 2,
    allowedWallets: [],
    keyEnvelopeCommitment,
    metadataCommitment,
    storageMode: 2,
    version: 1
  }));
  const prepared = await prepareBytes(ciphertext, name || `private/${blobId.slice(2)}`, expiresAt, blobId);
  return {
    ...prepared,
    ciphertext,
    originalSize: plaintext.length,
    keyEnvelope,
    keyEnvelopeCommitment,
    metadataCommitment,
    policy: {
      storageMode: 2,
      accessPolicy: 2,
      policyCommitment,
      keyEnvelopeCommitment,
      metadataCommitment
    },
    contentType: file.type || "application/octet-stream"
  };
}

export function jsonBytes(value: unknown): `0x${string}` {
  return hex(new TextEncoder().encode(canonicalJson(value)));
}

export function bytes32(value: Uint8Array | string): `0x${string}` {
  return digest(value);
}
