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

The canonical Coston2 deployment for the current proof is recorded in [docs/evidence/coston2-live-proof.md](../docs/evidence/coston2-live-proof.md).
