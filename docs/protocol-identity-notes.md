# Prime Server protocol identity notes

This note records the protocol decisions used for Prime Server’s developer layer.

## Identity and ownership

Prime Server identifies a developer blob by an owner wallet and a user-defined name. The owner controls the namespace, names are unique within that namespace, names can contain `/`, and names cannot end in `/`.

The write behavior is:

1. The client authenticates the owner wallet with a signed login message.
2. The gateway computes the blob commitment and encoding information.
3. The Flare registry records the owner, blob name, size, expiration, commitment, and encoding.
4. The coordinator distributes the encoded shards and records provider acknowledgements before finalization.

The RPC is an application-facing protocol boundary. The account and name are protocol identity, not only fields in a gateway database.

## Registry mapping

Prime Server carries this identity into the Flare registry:

- `owner` is the EVM wallet that owns the blob.
- `blobNames[blobId]` stores the full developer name on Flare.
- `blobNameHashes[blobId]` stores `keccak256(blobName)`.
- `blobIdByOwnerNameHash[owner][nameHash]` enforces owner-scoped name uniqueness.
- `BlobNamed` makes the name available to an event indexer.
- `/prime/v1/blobs/{account}/{blobName}` maps directly to that owner and name pair.

The current convenience gateway authenticates the wallet with a signed login message and uses the coordinator wallet for `createBlobForNamed`. The contract still records the authenticated wallet as owner, while the coordinator performs provider placement, acknowledgements, and recovery. A later protocol slice can let a wallet submit the named registration directly, or authorize the coordinator with an EIP-712 upload intent.

## Remaining parity work

The current developer layer deliberately keeps these capabilities explicit:

- commitment calculation currently runs in the gateway, with verification still performed by the provider and read paths
- the first API is capped at 2 MiB and does not include multipart uploads
- payment and read micropayment sessions are not enabled
- the four-provider deployment is a compact Coston2 network, with larger provider topologies planned

These are follow-up protocol slices. They do not change the owner and named-blob identity already present in the contract and gateway.
