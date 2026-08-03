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

Evidence: 2 erasure tests passed using the Clay Codes 0.0.3 runtime with a four-shard, two-data-shard, 1 MiB chunk layout.

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

Status: `complete`

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

Evidence: RPC integration test uploaded a real 2 MiB blob, stopped providers 2 and 4, reconstructed the blob from shards 0 and 2, and passed a byte-range read.

## Slice 7: Coston2 deployment

Status: `complete`

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

Current output: the replacement registry is deployed to Coston2 at `0x73f92b133e6259f170Bc42FA708F476CDE15AdD0`. The deployment succeeded in block `33585089`, the transaction is recorded in `docs/evidence/coston2-paid-live-proof.md`, and the live bytecode matches the Solidity `0.8.24` via-IR build at 23,489 bytes. Four funded provider operators registered successfully. The paid, private ciphertext, access-intent, and replacement-registry recovery proofs are recorded in the two Coston2 evidence documents.

## Slice 8: event indexer and recovery coordinator

Status: `complete`

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

Current output: `rpc/src/event-indexer.mjs` persists its cursor through `rpc/src/operational-store.mjs`, using 30-block windows for the Coston2 log limit. `PrimeServerRecoveryCoordinator` stores recovery jobs with leases, retry state, and completed results. `POST /v1/blobs/:blobId/recover` is queue-backed and idempotent. The live Coston2 run persisted its cursor, completed one recovery job, and recorded the result in the evidence bundle.

## Slice 9: end-to-end failure proof

Status: `complete`

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

Current output: `scripts/coston2-demo.mjs` ran the complete live proof on Coston2 against the replacement registry. A 2 MiB blob reached `active` after four provider acknowledgements. Provider 2 and provider 4 were stopped, shards 1 and 3 were removed from their storage paths, the original bytes were reconstructed from the two surviving shards, both missing shards were rebuilt, and the final state reached `rebuilt`. The input, recovered, and final SHA-256 hash were identical. The replacement run is `coston2-1785771713115-23093`, saved under `.prime-server/evidence/coston2/`, and summarized in `docs/evidence/coston2-live-proof.md`.

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

## Architecture extension queue

These slices extend the proven storage and recovery core. They do not replace the direct wallet registration, Clay encoding, provider acknowledgement, or recovery boundaries above.

## Slice 11: shared policy and native payment schema

Status: `complete for native Flare, XRP settlement pending`

Dependencies: Slice 9.

Output:

- `StorageMode`, `AccessPolicy`, `PaymentAsset`, and `PaymentStatus` contract enums.
- `BlobPolicy`, `BlobPayment`, and `PaidBlobRegistration` records.
- Native quote, atomic wallet payment plus registration, escrow, refund, provider claim, and protocol fee paths.
- SDK quote and paid-registration methods.
- Prime RPC payment and policy cross-checks.

Acceptance:

- Foundry tests prove policy recording, atomic native escrow, provider claims, fee accounting, and pending refund rules.
- A real local EVM test registers a paid blob, uploads it through the developer API, settles all four placement providers, and reads the settled payment state.
- The registry runtime stays below EIP-170 under the configured via-IR build.

Evidence: 8 Foundry tests pass. SDK and RPC suites pass. The real local EVM paid upload and four-provider settlement test passes. The fresh Coston2 paid run is recorded in `docs/evidence/coston2-paid-live-proof.md`. Runtime size is 23,489 bytes against the 24,576-byte limit.

## Slice 12: client-side encryption and FCC envelope preparation

Status: `locally complete`

Dependencies: Slice 11.

Output:

- AES-256-GCM client-side encryption.
- Clay commitment over ciphertext.
- ECIES-style envelope sealed to an FCC public key.
- Key-envelope and metadata commitments.
- SDK support for private and confidential preparation.

Acceptance:

- A prepared encrypted blob decrypts locally with the in-memory key.
- The Clay commitment matches the ciphertext sent to the provider engine.
- The serialized envelope contains no plaintext file key.
- Private and confidential policy combinations are rejected when invalid.

Evidence: SDK encryption tests pass. This slice has local cryptographic and commitment evidence only. It does not claim a live FCC key release.

## Slice 13: wallet authorization and confidential access boundary

Status: `locally complete, live FCC controller pending`

Dependencies: Slice 12.

Output:

- EIP-712 confidential access intent in the registry.
- Device-key commitment, deadline, purpose, and per-requester nonce.
- Selected-wallet policy entries.
- Controller-only access result consumption with a response commitment.
- SDK device-key and authorization helpers.
- Compute-only read rejection in Prime RPC.

Acceptance:

- A valid owner signature creates one access intent.
- A replayed nonce is rejected.
- A consumed request cannot be reused.
- A device-key commitment is present in the onchain intent.
- Confidential bytes are not returned by the gateway without an FCC result.

Evidence: Foundry, SDK, and RPC tests pass locally. A real FCC extension, approved code identity, TEE registration, attestation, and key rewrap proof are still required before live confidentiality claims.

## Slice 14: Flare Confidential Compute extension

Status: `pending`

Dependencies: Slice 13 and FCC deployment inputs.

Output:

- Prime Server FCC extension and instruction sender.
- Envelope ingestion inside the TEE.
- Wallet authorization and replay checks tied to the registry request.
- Device-bound key rewrap for private viewing.
- Approved code hash and attestation evidence.

Acceptance:

- Providers and Prime RPC receive ciphertext only.
- The registered FCC extension consumes a fresh request and returns a device-bound key package.
- The browser decrypts locally on a second device using the same wallet.
- The proof identifies the extension, code hash, TEE identity, request ID, and response commitment.

## Slice 15: XRP, FDC, and FAssets settlement

Status: `pending`

Dependencies: Slice 11 and a real escrow or attested external-payment settlement design.

Output:

- XRP payment quote and payment intent.
- FDC proof of the external payment.
- FXRP or escrow settlement path.
- Explicit refund and expiry handling.

Acceptance:

- A real external payment is independently proven by an FDC attestation or contract escrow.
- Prime Server does not label XRP as atomic until the external payment and storage registration have a verified settlement boundary.

## Slice 16: combined payment, privacy, failure, recovery, and access proof

Status: `pending`

Dependencies: Slice 11, Slice 12, Slice 13, and Slice 14.

Output:

```text
native payment
-> encrypted client preparation
-> wallet registration
-> ciphertext upload
-> provider settlement
-> provider failure
-> reconstruction and rebuild
-> FCC authorization
-> device-bound result
-> local decryption or confidential result
```

Acceptance:

- Every stage has a current receipt, event, hash, or attestation record.
- The final evidence clearly separates local, onchain, provider, and FCC proof.

## Slice 17: explorer and developer observability

Status: `pending`

Dependencies: Slice 16 and stable event, API, and contract fields.

Output:

- Blob and payment explorer.
- Provider placement and acknowledgement view.
- Recovery timeline.
- Policy and confidential access status.
- Direct links to Flare transactions and attestation evidence.

Acceptance:

- A reviewer can follow one blob from quote through storage, failure, recovery, payment settlement, and access result without opening a terminal.

## Slice 18: protocol hardening

Status: `pending`

Dependencies: Slice 17.

Output:

- Persistent challenge nonces, rate limits, and session revocation.
- Idempotent paid upload and settlement operations.
- Expiry cleanup and reusable owner-scoped names.
- Recovery settlement reserve for replacement providers.
- Contract and service security review.

Acceptance:

- The combined proof can be rerun from a clean state.
- No private key, secret, mock receipt, or unsupported production claim enters Git.

## Handoff rule for future sessions

Before starting work, read:

1. `README.md`
2. `architecture.md`
3. `SLICES.md`
4. `REQUESTED_INPUTS.md`
5. The latest Git commit and working-tree status

Then select the earliest `in progress` or unblocked `pending` slice. Do not skip acceptance tests or mark a live claim as complete without evidence.
