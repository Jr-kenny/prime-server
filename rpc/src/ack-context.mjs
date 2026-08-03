export function acknowledgementContext({ chainId, registryAddress, blobId, owner, nameHash, providerId, shardIndex, commitment, size }) {
  return [
    "prime-ack-v1",
    String(chainId),
    String(registryAddress).toLowerCase(),
    String(blobId).replace(/^0x/, "").toLowerCase(),
    String(owner).toLowerCase(),
    String(nameHash || "").replace(/^0x/, "").toLowerCase(),
    String(shardIndex),
    String(commitment).replace(/^0x/, "").toLowerCase(),
    String(size),
    String(providerId)
  ].join("|");
}
