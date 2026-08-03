# Prime Server Architecture

## 1. Project definition

Prime Server is an independent, Flare-native implementation of the core architecture behind Shelby's decentralized blob storage network.

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

The RPC is the client-facing control and data-plane gateway. The initial API should be small:

```text
POST /v1/blobs
POST /v1/blobs/:blobId/finalize
GET  /v1/blobs/:blobId
GET  /v1/blobs/:blobId/content
GET  /v1/blobs/:blobId/content?start=<byte>&end=<byte>
GET  /v1/providers
GET  /health
```

The upload path creates a blob plan, erasure-codes the input, assigns shards to providers, uploads the shards, verifies acknowledgements, and submits the required chain transactions.

The download path reads enough surviving shards to reconstruct the requested bytes. A range request must avoid reading the whole file when the shard layout allows a narrower read.

### 4.4 Coordinator and indexer

The coordinator watches PrimeServerRegistry events and maintains local operational state. The contract remains authoritative for protocol state.

The coordinator is responsible for:

- Selecting providers for a placement group.
- Tracking upload sessions.
- Waiting for provider acknowledgements.
- Detecting unavailable providers through health checks and read failures.
- Scheduling recovery and rebuild work.
- Writing a human-readable evidence record for every demo run.

The first local implementation may use SQLite for operational state. The protocol boundary must leave room for Postgres when the network becomes multi-hosted.

## 5. Data model

### Blob

```text
blobId             unique content or upload identifier
owner              Flare address
commitment         root commitment for the original blob
size               original byte length
chunkSize          initial value: 1 MiB
dataShards         initial value: 2
totalShards        initial value: 4
placementGroup     provider identifiers
status             pending, active, recovering, rebuilt, revoked
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
providerId         provider storing the shard
shardIndex         erasure-coded shard index
commitment         shard commitment
size               stored shard size
signature          provider signature over the acknowledgement
```

## 6. Erasure coding

The first network uses a four-shard, two-data-shard layout. Any two valid shards are sufficient to reconstruct the original data. This is the smallest layout that gives the live demo a meaningful failure event.

The implementation should reuse the tested Shelby-compatible Clay or Reed-Solomon data-plane primitives where licensing and package boundaries allow. The protocol must keep the coding layer behind an interface so the provider daemon can later support larger layouts such as ten data shards and sixteen total shards.

The following must be tested with deterministic fixtures:

- Encode and commit a file.
- Erase two shards.
- Recover the original bytes.
- Compare the recovered hash with the original hash.
- Rebuild the erased shards.
- Verify the rebuilt shard commitments.

The current provider implementation uses `@shelby-protocol/clay-codes` 0.0.3 through its Node WASM entry point. The four-provider Clay runtime requires 1 MiB chunks. Each shard carries two related commitments: a SHA-256 content commitment used by the provider storage and RPC boundary, and the Clay chunk or chunkset roots used to preserve the erasure-code verification path.

## 7. Onchain lifecycle

```text
register provider
        |
create blob and root commitment
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

## 8. Flare integration

The first deployment target is Flare Coston2.

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
- Full Shelby micropayment-channel parity.
- Production audit markets and penalty economics.
- Global provider discovery.
- Multi-region deployment.
- Public user storage guarantees.
- FDC or FCC extensions before the core loop is proven.

## 11. Current evidence

Verified before implementation in this repository:

- Shelby-compatible four-provider erasure recovery passed locally.
- Shelby-compatible sixteen-provider erasure recovery passed locally.
- Flare Coston2 RPC responded with chain ID 114.
- The broader XMTP checkout was inspected separately and remains a separate project option.

Repository status:

- Scaffold created: 2026-08-03.
- Prime Server contract not yet deployed.
- No public endpoint exists yet.
- No storage or payment claim is valid until a test run records evidence.
