# Prime Server Coston2 hardening registry deployment

This record covers the fresh `PrimeServerRegistry` deployment after the payment, metadata, and access hardening work in Slice 11A. It proves that the frozen registry build is deployed and readable on Coston2. It does not claim a fresh paid upload, provider settlement, recovery run, FCC attestation, confidential key release, or XRP/FDC/FAssets settlement.

Deployment:

- Network: Flare Coston2
- Chain ID: `114`
- Registry: `0x2049Bc9475B88B55D6d43aE28263D68719251113`
- Transaction: `0xf21b0622b5d4c68b8f96379f610305914769b817556196f3732d102cc6bb1526`
- Deployment block: `33589954`
- Deployer: `0xa64f1832D8Dd4F8c6Ad434D3942a09fEFc9ad2b3`
- Initial admin: `0xa64f1832D8Dd4F8c6Ad434D3942a09fEFc9ad2b3`
- Receipt status: success
- Runtime bytecode: `24,355` bytes
- Compiler: Solidity `0.8.24`, optimizer runs `100`, via-IR

Read-only verification confirmed chain ID `114`, a successful deployment receipt, non-empty runtime bytecode at the registry address, the expected deployer as `admin()`, and the configured native rate of `1_000_000_000_000` wei per MiB per shard.

This address is the current Coston2 registry target for the next live paid-storage, private-ciphertext, provider-failure, and recovery proof. The earlier Coston2 addresses remain historical evidence for their respective builds.
