# PrimeServerRegistry deployment

The first deployment command uses Foundry's built-in contract creation flow. Run it from the repository root after the deployer key has been placed in a local environment file.

```bash
forge create \
  --rpc-url "$PRIME_SERVER_RPC_URL" \
  --private-key "$PRIME_SERVER_DEPLOYER_PRIVATE_KEY" \
  contracts/src/PrimeServerRegistry.sol:PrimeServerRegistry
```

Record the returned contract address, transaction hash, deployment block, chain ID, and compiler version in the evidence log. Never place the private key in Git or chat.

