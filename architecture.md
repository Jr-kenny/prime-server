# Prime Server Architecture

## 1. Project definition

Prime Server is an independent, Flare-native decentralized blob storage network.

It gives users a storage API while using multiple independent provider processes to store erasure-coded data. Flare smart contracts act as the coordination and verification layer for providers, blob commitments, placement, acknowledgements, payment state, and recovery events.

The first target is a complete end-to-end network loop on Coston2 with four real providers. The four-provider topology is a compact test network that preserves the important protocol behavior and can later expand to a larger provider set.

## 2. What Prime Server must prove

The first release is successful only when all of these are true in one reproducible run:

- A client uploads a real file through the Prime Server RPC.
- The file is split into fixed-size chunks and erasure-coded into provider shards.
- Each provider stores a real shard in its own data directory.
- The original file commitment and provider placement are recorded on Flare.
- Providers return signed acknowledgements for the shards they store.
- At least two providers can be stopped without making the file unreadable.
- The download path reconstructs the original bytes from surviving shards.
- Missing shards can be rebuilt onto replacement or restarted providers.
- The final file hash matches the original hash.
- The demo records contract addresses, transaction hashes, provider logs, and recovery evidence.

## 3. System boundary

```text
                         Flare Coston2
                +---------------------------+
                | PrimeServerRegistry       |
                | provider registry         |
                | blob commitments          |
                | shard placement           |
                | acknowledgements          |
                | recovery records          |
                +-------------+-------------+
                              ^
                              | transactions and events
                              |
+-------------+       +------+-------+       +-------------+
| Client / UI | ----> | Prime RPC   | ----> | Provider 1  |
+-------------+       | coordinator |       +-------------+
                      +------+-------+       +-------------+
                             |              | Provider 2  |
                             +------------> +-------------+
                             |              | Provider 3  |
                             +------------> +-------------+
                             |              | Provider 4  |
                             +------------> +-------------+
                                             local shard data
```

The chain stores small, verifiable coordination records. File bytes remain in the provider data plane. The RPC and provider services must never claim that a file is stored only because a transaction was sent. Storage is confirmed by provider acknowledgements and a successful read or recovery test.

## 4. Components

### 4.1 PrimeServerRegistry

The first contract is the source of truth for the demo network. It will support:

- Provider registration with operator address, endpoint, and signing identity.
- Blob creation with owner, size, chunk size, erasure parameters, and root commitment.
- Shard placement across registered providers.
- Provider acknowledgements for stored shard commitments.
- Blob finalization after the required acknowledgements arrive.
- Recovery and rebuild records when a missing shard is recreated.
- Events for the RPC indexer and the demo evidence log.

The contract must not store file bytes. It stores commitments, identifiers, and state transitions that can be independently checked.

### 4.2 Provider daemon

Each provider is a separate process with an isolated data directory. A provider must:

- Register or load its operator identity.
- Accept shard uploads from the RPC coordinator.
- Persist shard bytes before returning an acknowledgement.
- Calculate and return a shard commitment.
- Sign the acknowledgement payload with its provider key.
- Serve shard downloads and range reads.
- Report health and storage status.
- Rebuild a missing shard when the recovery coordinator assigns it.

The demo must run four processes, even when all four processes run on the same Mac. Process isolation and separate data directories are required so that stopping one provider produces a real failure.

### 4.3 Prime RPC

The RPC contains two boundaries. The legacy `/v1` routes support the internal proof harness. The developer-facing `/prime/v1` routes are the product API that external applications consume.

The developer API is wallet-owned and named like a normal blob service:

```text
GET  /prime/v1/auth/challenge?address=<wallet>
POST /prime/v1/auth/session
PUT  /prime/v1/blobs/<wallet>/<blob-name>
GET  /prime/v1/blobs/<wallet>/<blob-name>
HEAD /prime/v1/blobs/<wallet>/<blob-name>
GET  /prime/v1/blobs/<wallet>
```

The initial internal API remains small:

```text
POST /v1/blobs
POST /v1/blobs/:blobId/finalize
GET  /v1/blobs/:blobId
GET  /v1/blobs/:blobId/content
GET  /v1/blobs/:blobId/content?start=<byte>&end=<byte>
GET  /v1/providers
GET  /health
```

The developer upload path has a registration-first boundary. The client erasure-codes the input and computes the Clay commitment locally. The user wallet submits `createBlobNamed` directly to Flare and waits for confirmation. The client then sends the original bytes and the registration identifier to Prime RPC. RPC reads the registration from Flare, recomputes the encoding and commitment, checks the owner, name, size, expiry, and supported parameters, then distributes the shards and records acknowledgements. The gateway session authenticates API access and rate limits, but it never creates a user-owned blob or determines its owner.

The contract also exposes explicit operator creation methods for coordinator-owned internal objects. Those methods set the coordinator as owner and record `Operator` origin. They cannot assign a user wallet as the owner.

The target download path reads enough surviving shards to reconstruct the requested bytes. The current first implementation reconstructs the complete object and then applies HTTP range slicing, so efficient shard-range retrieval remains a separate slice. The developer API adds a JavaScript SDK, while multipart uploads and an S3-compatible gateway remain planned compatibility layers.

### 4.4 Coordinator and indexer

The coordinator watches PrimeServerRegistry events and maintains local operational state. The contract remains authoritative for protocol state.

The coordinator is responsible for:

- Selecting providers for a placement group.
- Tracking upload sessions.
- Waiting for provider acknowledgements.
- Detecting unavailable providers through health checks and read failures.
- Scheduling recovery and rebuild work.
- Writing a human-readable evidence record for every demo run.

The current single-coordinator implementation uses an atomic JSON operational store for its cursor and recovery queue. The protocol boundary leaves room for SQLite or Postgres when the network becomes multi-hosted.

The repository includes an explicit `MemoryRegistry` adapter for local integration tests. It verifies provider public-key signatures and enforces the same placement and acknowledgement rules without claiming to be Flare state. The production path will use a Flare contract adapter.

## 5. Data model

### Blob

```text
blobId             unique content or upload identifier
owner              Flare address
blobName           owner-scoped developer object name
nameHash           keccak256(blobName), indexed by owner
commitment         root commitment for the original blob
size               original byte length
chunkSize          initial value: 1 MiB
dataShards         initial value: 2
totalShards        initial value: 4
placementGroup     provider identifiers
status             pending, active, recovering, rebuilt, revoked
origin             User or Operator
expiresAt          optional UNIX expiry recorded on Flare
```

### Provider

```text
providerId         onchain provider identifier
operator           Flare address that controls the provider
endpoint           provider API endpoint
signingKeyId       identifier for the provider signing key
active             registration and health state
```

### Shard acknowledgement

```text
blobId             blob being acknowledged
chainId            network where the registration exists
registryAddress    registry contract that owns the lifecycle
owner              registered blob owner
nameHash           owner-scoped name commitment
providerId         provider storing the shard
shardIndex         erasure-coded shard index
commitment         shard commitment
size               stored shard size
signature          provider signature over the acknowledgement
```

## 6. Erasure coding

The first network uses a four-shard, two-data-shard layout. Any two valid shards are sufficient to reconstruct the original data. This is the smallest layout that gives the live demo a meaningful failure event.

The implementation should reuse tested Clay or Reed-Solomon data-plane primitives where licensing and package boundaries allow. The protocol must keep the coding layer behind an interface so the provider daemon can later support larger layouts such as ten data shards and sixteen total shards.

The following must be tested with deterministic fixtures:

- Encode and commit a file.
- Erase two shards.
- Recover the original bytes.
- Compare the recovered hash with the original hash.
- Rebuild the erased shards.
- Verify the rebuilt shard commitments.

The current provider implementation uses the Clay Codes 0.0.3 Node WASM runtime. The four-provider Clay runtime requires 1 MiB chunks. Each shard carries two related commitments: a SHA-256 content commitment used by the provider storage and RPC boundary, and the Clay chunk or chunkset roots used to preserve the erasure-code verification path.

## 7. Onchain lifecycle

```text
register provider
        |
client computes encoding and root commitment
        |
user wallet registers the blob and commitment on Flare
        |
Prime RPC reads and verifies the registration
        |
assign shard placement
        |
upload shards to providers
        |
provider signs acknowledgement
        |
record acknowledgements on Flare
        |
finalize blob
        |
provider failure detected
        |
recover from surviving shards
        |
record rebuild and new acknowledgement
```

No stage may advance only because the coordinator says it did. Each stage needs a local receipt, a provider record, a transaction or event where applicable, and a content hash where bytes are involved.

## 8.1 Registration-first write protocol

```text
client selects file
        |
client computes Clay encoding and commitment
        |
wallet calls createBlobNamed(...)
        |
Flare records msg.sender as owner
        |
client waits for the registration receipt
        |
client sends original bytes to Prime RPC
        |
RPC reads the registration and recomputes the commitment
        |
RPC distributes shards and verifies provider acknowledgements
        |
coordinator finalizes the registered blob
```

The public API requires `x-prime-blob-id` and checks the onchain registration before reading the request body. The request can include commitment, expiry, size, and encoding headers as cross-checks. The registry remains authoritative for those values. A blob that is already active, expired, revoked, or registered to another account cannot be uploaded through the public route.

## 8. Flare integration

The first deployment target is Flare Coston2.

The current Coston2 proof was produced by an earlier registry build. The registration-first source change adds `BlobOrigin` and explicit operator creation methods, so a fresh registry deployment is required before rolling this boundary to the public Coston2 node. No replacement deployment is performed automatically.

```text
chain ID: 114
RPC:      https://coston2-api.flare.network/ext/C/rpc
WSS:      wss://coston2-api.flare.network/ext/C/ws
```

The contract uses ordinary EVM transactions and events. The RPC and indexer use the Coston2 JSON-RPC and WebSocket endpoints.

Possible extensions after the core recovery loop works:

- Use FDC to verify an external payment or asset event before accepting a storage session.
- Use a Flare-native asset for storage settlement.
- Use FCC for a confidential storage policy or confidential key-release operation.

These extensions are optional. They must not delay the core upload, failure, recovery, and proof loop.

## 9. Security and trust model

Prime Server is an accountable storage network, not an assertion that providers are trusted.

- Provider keys sign acknowledgements.
- Blob owners control blob creation and recovery authorization.
- The contract records commitments rather than trusting a database row.
- The RPC verifies returned shard commitments before reconstruction.
- A provider acknowledgement is not sufficient proof that a later read will succeed.
- A successful recovery requires the reconstructed content hash to match the registered blob commitment.
- Private keys and test funds stay in environment variables or a local secret manager. They must never enter Git.

## 10. Scope for the first show

Included:

- Four real provider processes.
- One Flare registry contract.
- Upload, download, and range-read paths.
- Erasure coding and commitments.
- Provider acknowledgements.
- Provider shutdown and recovery.
- Rebuild after recovery.
- Coston2 transaction and log evidence.
- A polished operator view for the demo.

Deferred:

- A sixteen-provider production topology.
- Full micropayment-channel parity.
- Production audit markets and penalty economics.
- Global provider discovery.
- Multi-region deployment.
- Public user storage guarantees.
- FDC or FCC extensions before the core loop is proven.

## 11. Current evidence

Verified before implementation in this repository:

- Four-provider erasure recovery passed locally.
- Sixteen-provider erasure recovery passed locally.
- Flare Coston2 RPC responded with chain ID 114.
- The broader XMTP checkout was inspected separately and remains a separate project option.

Repository status:

- Scaffold created: 2026-08-03.
- PrimeServerRegistry deployed to Coston2 at `0x9864476bFFBe1d261419Bc6b1b6ec3c00CF65325` in block `33577929`.
- A live 2 MiB upload, two-provider failure, reconstruction, shard rebuild, and final hash proof passed on Coston2.
- No public endpoint exists yet.
- The local proof does not make a production storage or payment claim. Its exact evidence is recorded in `docs/evidence/coston2-live-proof.md`.
