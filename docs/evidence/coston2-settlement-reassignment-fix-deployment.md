# Prime Server Coston2 settlement reassignment fix deployment

This record covers the final `PrimeServerRegistry` deployment after the recovery settlement regression was fixed. Immediate and reserve claim markers now use provider ID `0` as a global per-blob, per-shard sentinel. The active placement still determines which provider receives the payout.

The regression test follows this sequence:

```text
original provider acknowledges
-> original provider claims the immediate reward
-> recovery reassigns the shard
-> replacement provider acknowledges the rebuilt shard
-> expiry passes
-> replacement provider claims the reserve only
-> payment reaches Settled
```

Deployment:

- Network: Flare Coston2
- Chain ID: `114`
- Registry: `0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1`
- Transaction: `0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e`
- Deployment block: `33590506`
- Deployer: `0xa64f1832D8Dd4F8c6Ad434D3942a09fEFc9ad2b3`
- Initial admin: `0xa64f1832D8Dd4F8c6Ad434D3942a09fEFc9ad2b3`
- Receipt status: success
- Runtime bytecode: `24,355` bytes
- Compiler: Solidity `0.8.24`, optimizer runs `100`, via-IR

Validation:

- Foundry: `13` tests passed, including `testRecoveryReassignmentPaysImmediateOnceAndReplacementReserve`.
- FCC: `4` tests passed.
- SDK: `9` tests passed.
- RPC: `8` tests passed.
- Provider: `4` tests passed.
- Read-only Coston2 verification confirmed chain ID `114`, successful deployment, non-empty runtime bytecode, the expected admin, and empty global claim markers for an unused blob.

The complete final-registry provider, failure, recovery, and paid settlement proof is recorded in [coston2-live-provider-recovery-settlement-proof.md](./coston2-live-provider-recovery-settlement-proof.md). FCC attestation and XRP/FDC/FAssets settlement remain separate pending layers.
