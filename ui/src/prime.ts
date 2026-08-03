import { createEncoder } from "@shelby-protocol/clay-codes";
import { bytesToHex } from "viem";

export const BLOB_CONFIG = { n: 4, k: 2, d: 3, chunkSizeBytes: 1024 * 1024 } as const;

async function sha256(bytes: Uint8Array) {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export type PreparedBlob = {
  blobId: `0x${string}`; name: string; commitment: `0x${string}`; size: number;
  chunkSize: number; dataShards: number; totalShards: number; expiresAt: number;
  chunkCommitments: string[];
};

export async function prepareFile(file: File, name: string, expiresAt: number): Promise<PreparedBlob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!name || new TextEncoder().encode(name).length > 1024 || name.startsWith("/") || name.endsWith("/")) throw new Error("Enter a valid blob name");
  if (!bytes.length) throw new Error("The file is empty");
  const capacity = BLOB_CONFIG.k * BLOB_CONFIG.chunkSizeBytes;
  if (bytes.length > capacity) throw new Error("The current network limit is 2 MiB per blob");
  const padded = new Uint8Array(capacity);
  padded.set(bytes);
  const encoder = await createEncoder(BLOB_CONFIG);
  const encoded = encoder.erasureCode(padded);
  const commitments = await Promise.all(encoded.chunks.map((chunk: Uint8Array) => sha256(new Uint8Array(chunk))));
  const clay = encoder.getMerkleCommitment();
  return {
    blobId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), name,
    commitment: bytesToHex(new Uint8Array(clay.chunksetRoot)), size: bytes.length,
    chunkSize: BLOB_CONFIG.chunkSizeBytes, dataShards: BLOB_CONFIG.k,
    totalShards: BLOB_CONFIG.n, expiresAt,
    chunkCommitments: commitments.map(commitment => bytesToHex(commitment))
  };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export function shortHex(value?: string, head = 7, tail = 5) {
  if (!value) return "Not available";
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}
