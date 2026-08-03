# Prime Server Build Plan

## Working rule

Build the complete visible protocol loop first. Every milestone must leave behind code, a test, or a recorded proof.

## Day 0: repository and contracts boundary

- [x] Create permanent `/Users/user/Documents/prime-server` checkout.
- [x] Write architecture and live-demo specification.
- [x] Initialize Git repository.
- [ ] Confirm Solidity compiler and Foundry build.
- [ ] Add contract unit tests.

## Day 1: contract foundation

- [ ] Implement provider registration.
- [ ] Implement blob creation and commitment storage.
- [ ] Implement shard placement.
- [ ] Implement provider acknowledgements.
- [ ] Emit events for every state transition.
- [ ] Build and test locally with Foundry.

## Day 2: provider storage daemon

- [ ] Create provider process with an isolated data directory.
- [ ] Add provider registration configuration.
- [ ] Add shard upload and durable write path.
- [ ] Add shard download and range-read path.
- [ ] Add health and storage status endpoints.
- [ ] Add signed acknowledgement generation.

## Day 3: erasure and commitment pipeline

- [ ] Integrate four-shard encoding.
- [ ] Generate original and shard commitments.
- [ ] Verify commitments on upload and download.
- [ ] Add deterministic recovery fixtures.
- [ ] Prove two-shard loss recovery locally.

## Day 4: Prime RPC

- [ ] Implement blob upload session.
- [ ] Implement placement selection.
- [ ] Upload shards to all four providers.
- [ ] Verify acknowledgements.
- [ ] Implement blob finalize.
- [ ] Implement full download and range read.

## Day 5: Coston2 deployment

- [ ] Deploy the registry to Coston2.
- [ ] Record deployment address and transaction hash.
- [ ] Configure the RPC and coordinator against Coston2.
- [ ] Run a real test upload with funded test wallets.
- [ ] Save the evidence record.

## Day 6: failure and recovery

- [ ] Detect provider failure through health and read checks.
- [ ] Reconstruct a missing shard from surviving providers.
- [ ] Rebuild the shard on a replacement or restarted provider.
- [ ] Record the recovery event onchain.
- [ ] Verify the final file hash.

## Day 7: operator view and evidence

- [ ] Show provider status.
- [ ] Show blob commitment and placement.
- [ ] Show acknowledgement progress.
- [ ] Show provider shutdown.
- [ ] Show recovery and rebuild progress.
- [ ] Link every chain action to a block explorer transaction.

## Day 8: hardening

- [ ] Add idempotent uploads and retries.
- [ ] Reject mismatched shard commitments.
- [ ] Handle duplicate acknowledgements.
- [ ] Handle provider restart without data loss.
- [ ] Validate input sizes and erasure parameters.
- [ ] Add structured logs and a run identifier.

## Day 9: end-to-end test gate

- [ ] Run the complete flow from a clean local state.
- [ ] Run the complete flow on Coston2.
- [ ] Shut down two providers during a download.
- [ ] Recover and rebuild the file.
- [ ] Confirm hashes, events, logs, and transaction receipts.

## Day 10: presentation quality

- [ ] Make the operator view clear without hiding raw evidence.
- [ ] Prepare the two-minute explanation.
- [ ] Prepare the failure and recovery sequence.
- [ ] Capture screenshots and transaction links.
- [ ] Write the final technical description.

## Day 11: release gate

- [ ] Freeze the demo path.
- [ ] Run from the documented commands.
- [ ] Remove unsupported claims.
- [ ] Commit the final build and evidence.
- [ ] Record known limitations and next steps.

## Stop conditions

Do not add FDC, FCC, micropayments, or a larger provider topology until the following already works:

```text
real upload -> real provider writes -> Flare commitment -> provider failure
-> successful reconstruction -> rebuild -> matching final hash
```

