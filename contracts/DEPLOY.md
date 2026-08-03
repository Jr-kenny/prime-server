# PrimeServerRegistry deployment

The deployment command uses Foundry's built-in contract creation flow. Run it from the `contracts` package after the deployer key has been placed in the ignored local `.env` file.

```bash
cd /Users/user/Documents/prime-server/contracts
forge create \
  --broadcast \
  --rpc-url "$PRIME_SERVER_RPC_URL" \
  --private-key "$PRIME_SERVER_DEPLOYER_PRIVATE_KEY" \
  src/PrimeServerRegistry.sol:PrimeServerRegistry
```

Record the returned contract address, transaction hash, deployment block, chain ID, and compiler version in the evidence log. Never place the private key in Git or chat.

The current frozen Coston2 registry deployment, including the recovery settlement reassignment fix, is recorded in [docs/evidence/coston2-settlement-reassignment-fix-deployment.md](../docs/evidence/coston2-settlement-reassignment-fix-deployment.md). The first post-hardening deployment is preserved in [docs/evidence/coston2-registry-hardening-deployment.md](../docs/evidence/coston2-registry-hardening-deployment.md). The earlier paid proof and storage/recovery run remain historical evidence in [docs/evidence/coston2-paid-live-proof.md](../docs/evidence/coston2-paid-live-proof.md) and [docs/evidence/coston2-live-proof.md](../docs/evidence/coston2-live-proof.md).

The source contract now includes `BlobOrigin`, native payment escrow, duration pricing, a post-expiry provider reserve, global per-shard settlement markers, storage policy, confidential access requests, `createOperatorBlob`, and `createOperatorBlobNamed`. The current build uses Solidity `0.8.24`, optimizer runs `100`, and via-IR compilation. Use the frozen deployment recorded in the settlement reassignment evidence. Do not point the RPC at an earlier proof address because its ABI and ownership boundary are different.

The registry ABI and storage layout are frozen after the settlement reassignment fix. The corrected registry is deployed, and the live provider, recovery, native payment, and settlement proof is recorded in [docs/evidence/coston2-live-provider-recovery-settlement-proof.md](../docs/evidence/coston2-live-provider-recovery-settlement-proof.md). FCC instruction transport and XRP, FDC, and FAssets settlement remain separate contracts or extensions.

## FCC instruction sender

`src/fcc/PrimeServerInstructionSender.sol` is deployed separately from `PrimeServerRegistry`. Deploy it with the Coston2 `TeeExtensionRegistry` and `TeeMachineRegistry` addresses, register the sender as the FCC extension instruction sender, then call `setExtensionId()` once. The Prime Server registry admin must grant the sender address `confidentialAccessController` permission before a result relay can call `recordAccessResult`.

The sender and extension core are locally tested only. Do not record a live FCC deployment, approved TEE code hash, attestation, or key release until the official Flare FCE registration and end-to-end flow has completed.
