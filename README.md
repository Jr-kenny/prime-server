# Prime Server

Prime Server is a Flare-native, verifiable decentralized storage network inspired by Shelby's erasure-coded storage architecture.

The project is built around one visible proof:

1. Upload a real file to multiple provider processes.
2. Record its commitment and placement on Flare.
3. Take providers offline.
4. Recover the original file from the surviving providers.
5. Rebuild the missing shards and show the onchain verification trail.

The first live proof is complete on Flare Coston2. A real 2 MiB blob was uploaded through Prime RPC, acknowledged by four provider processes, recovered after providers 2 and 4 were stopped, rebuilt, and read back with an identical SHA-256 hash. The registry address, transaction hashes, event counts, and limits of the local proof are recorded in [docs/evidence/coston2-live-proof.md](./docs/evidence/coston2-live-proof.md).

## Start here

- [architecture.md](./architecture.md) explains the system boundary and data flow.
- [SLICES.md](./SLICES.md) is the execution queue. It has no calendar-day assumptions.
- [docs/demo-script.md](./docs/demo-script.md) defines the live failure and recovery demonstration.
- [REQUESTED_INPUTS.md](./REQUESTED_INPUTS.md) lists the access, software, and test resources needed to run the slices.
- [contracts/DEPLOY.md](./contracts/DEPLOY.md) records the deployment command and evidence requirements.
- [scripts/coston2-demo.mjs](./scripts/coston2-demo.mjs) runs the live upload, failure, recovery, rebuild, and final-read proof.
- [docs/evidence/coston2-live-proof.md](./docs/evidence/coston2-live-proof.md) records the canonical Coston2 run.
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

## Run the live proof

Place the five test-only private keys and the Coston2 endpoints in the ignored `.env` file. Set `PRIME_SERVER_REGISTRY_ADDRESS` to the deployed registry address, then run:

```bash
node scripts/coston2-demo.mjs
```

The command starts four isolated provider processes, writes a real blob, records the Flare lifecycle, takes two providers offline, reconstructs the blob, rebuilds the missing shards, and saves a machine-readable record under `.prime-server/evidence/coston2/`.
