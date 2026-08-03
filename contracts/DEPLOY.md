# PrimeServerRegistry deployment

The deployment command uses Foundry's built-in contract creation flow. Run it from the `contracts` package after the deployer key has been placed in the ignored local `.env` file.

```bash
cd /Users/user/Documents/prime-server/contracts
forge create \
  --rpc-url "$PRIME_SERVER_RPC_URL" \
  --private-key "$PRIME_SERVER_DEPLOYER_PRIVATE_KEY" \
  src/PrimeServerRegistry.sol:PrimeServerRegistry
```

Record the returned contract address, transaction hash, deployment block, chain ID, and compiler version in the evidence log. Never place the private key in Git or chat.

The canonical Coston2 deployment for the current paid and policy proof is recorded in [docs/evidence/coston2-paid-live-proof.md](../docs/evidence/coston2-paid-live-proof.md). The earlier storage and recovery run remains documented in [docs/evidence/coston2-live-proof.md](../docs/evidence/coston2-live-proof.md).

The source contract now includes `BlobOrigin`, native payment escrow, duration pricing, a post-expiry provider reserve, storage policy, confidential access requests, `createOperatorBlob`, and `createOperatorBlobNamed`. The current build uses Solidity `0.8.24`, optimizer runs `100`, and via-IR compilation. Deploy a replacement registry before using the registration-first public API. Do not point the new RPC at the earlier proof address because its ABI and ownership boundary are different.

The registry ABI and storage layout are frozen after the local payment, metadata, and access hardening slice. FCC instruction transport and XRP, FDC, and FAssets settlement must be deployed as separate contracts or extensions. A new registry deployment and live proof are still required before this build is described as live Coston2 infrastructure.

## FCC instruction sender

`src/fcc/PrimeServerInstructionSender.sol` is deployed separately from `PrimeServerRegistry`. Deploy it with the Coston2 `TeeExtensionRegistry` and `TeeMachineRegistry` addresses, register the sender as the FCC extension instruction sender, then call `setExtensionId()` once. The Prime Server registry admin must grant the sender address `confidentialAccessController` permission before a result relay can call `recordAccessResult`.

The sender and extension core are locally tested only. Do not record a live FCC deployment, approved TEE code hash, attestation, or key release until the official Flare FCE registration and end-to-end flow has completed.
