import { createPublicKey, verify } from "node:crypto";

function fail(message) {
  throw new Error(message);
}

export class MemoryRegistry {
  constructor() {
    this.providers = new Map();
    this.blobs = new Map();
  }

  async registerProvider({ providerId, endpoint, publicKey }) {
    if (this.providers.has(providerId)) fail("provider already registered");
    this.providers.set(providerId, { providerId, endpoint, publicKey, active: true });
    return this.providers.get(providerId);
  }

  async createBlob({ blobId, owner, commitment, size, chunkSize, dataShards, totalShards }) {
    if (this.blobs.has(blobId)) fail("blob already exists");
    this.blobs.set(blobId, {
      blobId,
      owner,
      commitment,
      size,
      chunkSize,
      dataShards,
      totalShards,
      status: "pending",
      placement: new Map(),
      acknowledgements: new Map()
    });
  }

  async assignShard(blobId, shardIndex, providerId) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.status !== "pending") fail("blob is not pending");
    const provider = this.providers.get(providerId);
    if (!provider?.active) fail("provider is inactive");
    if (blob.placement.has(shardIndex)) fail("shard is already assigned");
    blob.placement.set(shardIndex, providerId);
  }

  async acknowledgeShard({ blobId, shardIndex, providerId, commitment, size, signedPayload, signature }) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.status !== "pending" && blob.status !== "recovering") fail("blob is not writable");
    if (blob.placement.get(shardIndex) !== providerId) fail("provider is not assigned");
    const provider = this.providers.get(providerId);
    if (!provider?.active) fail("provider is inactive");
    const publicKey = createPublicKey({
      key: Buffer.from(provider.publicKey, "base64"),
      type: "spki",
      format: "der"
    });
    const valid = verify(
      null,
      Buffer.from(signedPayload),
      publicKey,
      Buffer.from(signature, "base64")
    );
    if (!valid) fail("invalid provider acknowledgement signature");
    const expectedPayload = `${providerId}:${blobId}:${shardIndex}:${commitment}:${size}`;
    if (signedPayload !== expectedPayload) fail("acknowledgement payload mismatch");
    blob.acknowledgements.set(`${providerId}:${shardIndex}`, { providerId, shardIndex, commitment, size });
  }

  async finalizeBlob(blobId) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.acknowledgements.size !== blob.totalShards) fail("missing acknowledgements");
    blob.status = "active";
  }

  async startRecovery(blobId, shardIndex) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.status !== "active" && blob.status !== "rebuilt") fail("blob is not active");
    if (!blob.placement.has(shardIndex)) fail("shard is not assigned");
    blob.status = "recovering";
  }

  async reassignShard(blobId, shardIndex, providerId) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.status !== "recovering") fail("recovery is not active");
    if (!this.providers.get(providerId)?.active) fail("provider is inactive");
    blob.placement.set(shardIndex, providerId);
  }

  async recordRebuiltShard({ blobId, shardIndex, providerId, commitment }) {
    const blob = this.blobs.get(blobId);
    if (!blob) fail("blob does not exist");
    if (blob.status !== "recovering") fail("recovery is not active");
    if (blob.placement.get(shardIndex) !== providerId) fail("provider is not assigned");
    if (!commitment) fail("commitment is required");
    blob.status = "rebuilt";
  }

  getBlob(blobId) {
    const blob = this.blobs.get(blobId);
    if (!blob) return null;
    return {
      blobId: blob.blobId,
      owner: blob.owner,
      commitment: blob.commitment,
      size: blob.size,
      chunkSize: blob.chunkSize,
      dataShards: blob.dataShards,
      totalShards: blob.totalShards,
      status: blob.status,
      placement: Object.fromEntries(blob.placement),
      acknowledgements: [...blob.acknowledgements.values()]
    };
  }
}
