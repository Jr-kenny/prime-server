# Prime Server Build Slices

Slices are independent pieces of work with a concrete output and an acceptance test. They are not calendar days. A session should take the next unblocked slice, finish it, verify it, record evidence, and commit the result before moving on.

## Execution loop

```text
select next unblocked slice
        |
implement the smallest complete boundary
        |
run the acceptance test
        |
record evidence and update this file
        |
commit the slice
        |
select the next slice
```

Status values:

- `complete` means the output exists and the acceptance test passed.
- `in progress` means a session is actively implementing it.
- `blocked` means a specific external input or failure prevents progress.
- `pending` means its dependencies are not complete.

## Slice 0: repository baseline

Status: `complete`

Output:

- Permanent Git repository at `/Users/user/Documents/prime-server`.
- Architecture document.
- Demo script.
- Foundry configuration.
- Initial registry contract boundary.

Acceptance:

- `forge build` passes.
- Initial commit exists.

Evidence: commit `112df38`.

## Slice 1: contract test foundation

Status: `complete`

Dependencies: Slice 0.

Output:

- Foundry tests for provider registration and status.
- Tests for blob creation and ownership.
- Tests for placement and acknowledgement rules.
- Tests for finalization and recovery state transitions.
- Rejection tests for duplicate providers, invalid shards, inactive providers, and missing acknowledgements.

Acceptance:

- `forge test -vvv` passes from `contracts/`.
- Every public state transition has a test.

Evidence: 4 Foundry tests passed.

## Slice 2: provider storage core

Status: `complete`

Dependencies: Slice 1.

Output:

- One provider daemon with an isolated data directory.
- Durable shard write before acknowledgement.
- Shard download and byte-range read.
- Health endpoint and storage status.
- Provider acknowledgement signing.

Acceptance:

- A provider can restart without losing its stored shard.
- A mismatched content hash is rejected.
- The acknowledgement contains the blob ID, shard index, commitment, size, and provider identity.

Evidence: 2 provider tests passed. The daemon uses atomic writes, isolated data directories, range reads, and Ed25519 acknowledgements.

## Slice 3: erasure and commitment engine

Status: `complete`

Dependencies: Slice 2.

Output:

- Four-shard, two-data-shard encoding.
- Original blob commitment.
- Per-shard commitments.
- Reconstruction from any two valid shards.
- Rebuild of missing shards.

Acceptance:

- A deterministic fixture survives two erased shards.
- Recovered bytes have the original SHA-256 hash.
- Rebuilt shards have the expected commitments.

Evidence: 2 erasure tests passed using `@shelby-protocol/clay-codes` 0.0.3 with a four-shard, two-data-shard, 1 MiB chunk layout.

## Slice 4: multi-provider harness

Status: `complete`

Dependencies: Slice 2 and Slice 3.

Output:

- Four real provider processes.
- Separate ports and data directories.
- Start, stop, restart, and status commands.
- Provider failure injection for the live demo.

Acceptance:

- Stopping provider 2 and provider 4 produces real failed health checks.
- Provider 1 and provider 3 still serve enough data for reconstruction.

Evidence: `scripts/providers.mjs` starts and stops four isolated provider processes. The harness test stops providers 2 and 4 and confirms providers 1 and 3 remain healthy.

## Slice 5: Prime RPC upload path

Status: `complete`

Dependencies: Slice 1, Slice 3, and Slice 4.

Output:

- `POST /v1/blobs` upload session.
- Placement selection across active providers.
- Shard upload and acknowledgement verification.
- `POST /v1/blobs/:blobId/finalize`.

Acceptance:

- A real file is written to all four provider data directories.
- The explicit local registry adapter records the blob, placement, and verified acknowledgements.
- The RPC refuses to finalize when an acknowledgement is missing.

Evidence: RPC integration test passed with a real 2 MiB blob, four provider processes, four signed acknowledgements, and four stored shards. Coston2 contract writes remain in Slice 7.

## Slice 6: Prime RPC read path

Status: `pending`

Dependencies: Slice 5.

Output:

- Full blob download.
- Byte-range reads.
- Commitment verification before returning reconstructed bytes.
- Clear errors for unavailable or corrupt shards.

Acceptance:

- Full download matches the source hash.
- A range request matches the corresponding source byte range.
- A corrupt shard is detected and excluded from reconstruction.

## Slice 7: Coston2 deployment

Status: `pending`

Dependencies: Slice 1 and Slice 5.

Output:

- PrimeServerRegistry deployment to Coston2.
- Deployment address and transaction evidence.
- RPC configuration for Coston2 JSON-RPC and WebSocket events.
- Real provider registration on Coston2.

Acceptance:

- The deployed bytecode matches the local build.
- A provider registration and blob creation transaction are independently readable.
- The local evidence record contains chain ID, contract address, block numbers, and transaction hashes.

## Slice 8: event indexer and recovery coordinator

Status: `pending`

Dependencies: Slice 6 and Slice 7.

Output:

- Event listener for provider, blob, acknowledgement, and recovery events.
- Operational state store.
- Provider failure detection.
- Recovery job queue.
- Rebuild assignment and completion flow.

Acceptance:

- Restarting the coordinator does not lose completed onchain state.
- A failed provider creates a recoverable job.
- A recovery job can be retried safely.

## Slice 9: end-to-end failure proof

Status: `pending`

Dependencies: Slice 4, Slice 6, Slice 7, and Slice 8.

Output:

- One command that runs upload, failure, recovery, rebuild, and final read.
- Evidence bundle with hashes, logs, and transaction links.

Acceptance:

```text
real upload
-> real provider writes
-> Flare commitment
-> two provider failures
-> successful reconstruction
-> shard rebuild
-> matching final hash
```

## Slice 10: operator view

Status: `pending`

Dependencies: Slice 9.

Output:

- Provider status view.
- Blob commitment and placement view.
- Acknowledgement progress.
- Failure and recovery timeline.
- Direct transaction links.

Acceptance:

- The complete demo can be understood without opening a terminal.
- Raw evidence remains one click away.

## Slice 11: protocol hardening

Status: `pending`

Dependencies: Slice 9.

Output:

- Idempotent upload and recovery operations.
- Input validation and bounded resource use.
- Duplicate acknowledgement handling.
- Provider restart recovery.
- Structured logs with run IDs.
- Contract and service security review.

Acceptance:

- The end-to-end proof passes twice from a clean state.
- No private key, secret, or unsupported production claim enters Git.

## Slice 12: Flare-specific extension

Status: `pending`

Dependencies: Slice 9.

Choose one extension only after the core network proof is complete:

- FDC verification of an external payment or asset event.
- Flare-native asset settlement.
- FCC-protected storage policy or confidential key release.

Acceptance:

- The extension has a real Flare proof and a clear role in the storage lifecycle.
- The core failure and recovery path still works if the extension is disabled.

## Handoff rule for future sessions

Before starting work, read:

1. `README.md`
2. `architecture.md`
3. `SLICES.md`
4. `REQUESTED_INPUTS.md`
5. The latest Git commit and working-tree status

Then select the earliest `in progress` or unblocked `pending` slice. Do not skip acceptance tests or mark a live claim as complete without evidence.
