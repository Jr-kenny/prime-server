# Prime Server protocol identity notes

This note records the protocol decisions used for Prime Server’s developer layer.

## Identity and ownership

Prime Server identifies a developer blob by an owner wallet and a user-defined name. The owner controls the namespace, names are unique within that namespace, names can contain `/`, and names cannot end in `/`.

The public unpaid write behavior is:

1. The client computes the erasure encoding and commitment locally.
2. The owner wallet calls `createBlobNamed` directly on the Flare registry.
3. The client waits for the registration transaction to confirm.
4. The client authenticates to Prime RPC for API access and sends the original bytes with the registration metadata.
5. Prime RPC reads the registration, recomputes the encoding, verifies the owner, name, size, expiry, parameters, and commitment, then distributes shards.
6. Providers acknowledge their shards and the coordinator finalizes the registered blob.

The RPC is an application-facing protocol boundary. The account and name are protocol identity, not only fields in a gateway database.

## Registry mapping

Prime Server carries this identity into the Flare registry:

- `owner` is `msg.sender` for `createBlobNamed`.
- `blobNames[blobId]` stores the full developer name on Flare.
- `blobNameHashes[blobId]` stores `keccak256(blobName)`.
- `blobIdByOwnerNameHash[owner][nameHash]` enforces owner-scoped name uniqueness.
- `BlobNamed` makes the name available to an event indexer.
- `BlobOrigin.User` distinguishes direct wallet registration from internal operator objects.
- `/prime/v1/blobs/{account}/{blobName}` maps directly to that owner and name pair.

The public gateway authenticates the wallet for API access only. It never chooses the owner for a public blob. The coordinator performs provider placement, acknowledgement aggregation, finalization, and recovery after reading the user registration. Operator-created internal blobs use separate operator methods and are recorded with `Operator` origin.

The native paid write behavior keeps the same ownership boundary while adding a policy and payment tuple. The client prepares encryption and policy metadata when required, computes the Clay commitment over the bytes that will be uploaded, reads the native quote, and sends payment plus `createBlobNamedPaid` in one wallet transaction. The registry records `msg.sender` as the owner and holds the amount in escrow. Prime RPC checks that payment is still escrowed, verifies the policy commitments, stores the registered bytes, finalizes the blob, and submits provider settlement claims.

Private and confidential modes commit the FCC key envelope without exposing the file key to Prime RPC. The SDK generates an opaque `private/<blobId>` name and seals the original filename, content type, and supplied metadata inside the encrypted envelope. Confidential access uses a fresh EIP-712 request with a device-key commitment and a monotonic nonce. The contract records the request and allows an explicitly configured FCC access controller to consume it only while the request and blob remain valid and the requester remains authorized. This is an attested, verifiable, trust-minimized boundary until a live FCC extension and attestation proof is available.

## Acknowledgement binding

Provider acknowledgement payloads include the chain ID, registry address, blob ID, owner, name hash, shard index, shard commitment, shard size, and provider ID. The RPC verifies the signed payload before the memory adapter accepts it. The Flare adapter submits the acknowledgement from the registered provider operator, binding the transaction to the deployed registry and network.

## Remaining parity work

The current developer layer deliberately keeps these capabilities explicit:

- the SDK and compatible clients compute the commitment before registration, while RPC recomputes it before distribution
- the first API is capped at 2 MiB and does not include multipart uploads
- range reads currently reconstruct the full blob before slicing the HTTP response
- expiry hides expired objects at the gateway, while provider deletion and name reuse remain planned lifecycle work
- names are public registry metadata, so the SDK uses opaque names for private and confidential workloads while the original metadata stays inside the encrypted envelope
- selected wallets can retrieve ciphertext through an owner-scoped route by presenting a currently usable view request; confidential raw reads remain blocked
- challenge persistence, rate limiting, and session revocation remain public-auth hardening work
- native paid registration, duration pricing, immediate provider claims, and the post-expiry provider reserve are live on the frozen Coston2 registry, with the complete provider reassignment proof recorded in the evidence bundle
- XRP, FDC, and FAssets settlement are not enabled until a real escrow or attestation path exists
- live FCC key release and confidential compute are not enabled by local mocks
- the four-provider deployment is a compact Coston2 network, with larger provider topologies planned

These are follow-up protocol slices. They do not change the owner and named-blob identity present in the contract and gateway.
