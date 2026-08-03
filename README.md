# Prime Server

Prime Server is a Flare-native, verifiable decentralized storage network inspired by Shelby's erasure-coded storage architecture.

The project is built around one visible proof:

1. Upload a real file to multiple provider processes.
2. Record its commitment and placement on Flare.
3. Take providers offline.
4. Recover the original file from the surviving providers.
5. Rebuild the missing shards and show the onchain verification trail.

The project is in the architecture and scaffold phase. No public endpoint, production storage promise, or deployed contract should be assumed until it is recorded in the evidence log.

## Start here

- [architecture.md](./architecture.md) explains the system boundary and data flow.
- [PLAN.md](./PLAN.md) is the execution plan for the first eleven days.
- [docs/demo-script.md](./docs/demo-script.md) defines the live failure and recovery demonstration.
- [contracts/src/PrimeServerRegistry.sol](./contracts/src/PrimeServerRegistry.sol) is the first onchain coordination surface.

## Repository layout

```text
contracts/   Flare smart contracts and Foundry configuration
provider/    Storage provider daemon and local shard storage
rpc/         Client-facing upload, download, and range-read API
scripts/     Local network, deployment, and demo orchestration
docs/        Demo script and project decisions
test/        Cross-component and recovery tests
```

## Core rule

Every claim about Prime Server must be marked as implemented, locally verified, deployed, or planned. A simulated provider, fake receipt, or UI label is not proof of storage or settlement.

