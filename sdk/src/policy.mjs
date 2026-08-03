import { createHash } from "node:crypto";

export const STORAGE_MODES = Object.freeze({
  public: 0,
  private: 1,
  confidential: 2
});

export const ACCESS_POLICIES = Object.freeze({
  owner_only: 0,
  selected_wallets: 1,
  compute_only: 2
});

export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

function normalizeEnum(value, values, field) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/-/g, "_");
    if (Object.hasOwn(values, normalized)) return values[normalized];
  }
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= 0 && number <= 255) return number;
  throw new Error(`${field} must be a supported name or enum value`);
}

function normalizeBytes32(value, field, { allowZero = true } = {}) {
  const normalized = String(value || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) throw new Error(`${field} must be a 32-byte hex value`);
  if (!allowZero && normalized.toLowerCase() === ZERO_BYTES32) throw new Error(`${field} must not be zero`);
  return normalized.toLowerCase();
}

export function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function resolveStorageMode(value = "public") {
  return normalizeEnum(value, STORAGE_MODES, "storageMode");
}

export function resolveAccessPolicy(value = "owner_only") {
  return normalizeEnum(value, ACCESS_POLICIES, "accessPolicy");
}

export function policyCommitment({ storageMode, accessPolicy, keyEnvelopeCommitment = ZERO_BYTES32, metadataCommitment = ZERO_BYTES32, allowedWallets = [] } = {}) {
  const mode = resolveStorageMode(storageMode);
  const access = resolveAccessPolicy(accessPolicy);
  const envelope = normalizeBytes32(keyEnvelopeCommitment, "keyEnvelopeCommitment");
  const metadata = normalizeBytes32(metadataCommitment, "metadataCommitment");
  const wallets = [...allowedWallets].map((wallet) => String(wallet).toLowerCase()).sort();
  const encoded = canonicalJson({
    version: 1,
    storageMode: mode,
    accessPolicy: access,
    keyEnvelopeCommitment: envelope,
    metadataCommitment: metadata,
    allowedWallets: wallets
  });
  return `0x${createHash("sha256").update(encoded).digest("hex")}`;
}

export function normalizePolicy({ storageMode = "public", accessPolicy = "owner_only", policyCommitment, keyEnvelopeCommitment = ZERO_BYTES32, metadataCommitment = ZERO_BYTES32, allowedWallets = [] } = {}) {
  const mode = resolveStorageMode(storageMode);
  const access = resolveAccessPolicy(accessPolicy);
  const envelope = normalizeBytes32(keyEnvelopeCommitment, "keyEnvelopeCommitment");
  const metadata = normalizeBytes32(metadataCommitment, "metadataCommitment");
  if (mode === STORAGE_MODES.public && envelope !== ZERO_BYTES32) throw new Error("public storage cannot include a key envelope commitment");
  if (mode !== STORAGE_MODES.public && envelope === ZERO_BYTES32) throw new Error("private and confidential storage require a key envelope commitment");
  if (access === ACCESS_POLICIES.compute_only && mode !== STORAGE_MODES.confidential) throw new Error("compute-only access requires confidential storage");
  if (mode === STORAGE_MODES.confidential && access !== ACCESS_POLICIES.compute_only) throw new Error("confidential storage requires compute-only access");
  const resolvedCommitment = policyCommitment
    ? normalizeBytes32(policyCommitment, "policyCommitment", { allowZero: false })
    : policyCommitmentFor({ storageMode: mode, accessPolicy: access, keyEnvelopeCommitment: envelope, metadataCommitment: metadata, allowedWallets });
  return {
    storageMode: mode,
    accessPolicy: access,
    policyCommitment: resolvedCommitment,
    keyEnvelopeCommitment: envelope,
    metadataCommitment: metadata,
    allowedWallets: [...allowedWallets]
  };
}

export function policyCommitmentFor({ storageMode, accessPolicy, keyEnvelopeCommitment, metadataCommitment, allowedWallets } = {}) {
  return policyCommitment({ storageMode, accessPolicy, keyEnvelopeCommitment, metadataCommitment, allowedWallets });
}

export function enumName(value, values) {
  return Object.entries(values).find(([, number]) => number === Number(value))?.[0] || "unknown";
}
