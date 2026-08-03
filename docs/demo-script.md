# Prime Server Live Demo

## Goal

Show that Prime Server keeps data available through provider failure and can prove the recovery sequence with Flare state.

## Automated run

With the ignored `.env` configured, run `node scripts/coston2-demo.mjs` from the repository root. The command starts the four providers, performs the upload and failure sequence, writes the Coston2 transactions, and saves the machine-readable evidence under `.prime-server/evidence/coston2/`.

## Before the demo

- Four provider processes are running with separate data directories.
- The registry contract address is visible.
- The wallet has enough Coston2 test funds.
- The operator view is connected to the live RPC.
- The test file and expected SHA-256 hash are recorded.
- All four provider health checks pass.

## Demo sequence

1. Select a real file and show its local SHA-256 hash.
2. Upload it through the Prime Server RPC.
3. Show the erasure-coded shard plan.
4. Show each provider writing its shard.
5. Show provider acknowledgements and the Flare transaction.
6. Show the blob as active and retrievable.
7. Stop provider 2 and provider 4 as real processes.
8. Request the file again.
9. Show the RPC reading the two surviving shards and reconstructing the original bytes.
10. Show that the recovered SHA-256 hash matches the original.
11. Restart or replace the failed providers.
12. Rebuild the missing shards.
13. Record the rebuild acknowledgement and recovery event on Flare.
14. Read the file again from the rebuilt placement.

## Evidence to save

```text
run ID
input file hash
blob ID
blob commitment
registry contract address
create transaction hash
acknowledgement transaction hashes
provider log paths
failure timestamps
recovery timestamp
rebuild transaction hash
recovered file hash
final provider status
```

## Spoken explanation

Prime Server stores data across independent providers instead of trusting one server. The chain records what should exist and who accepted each shard. When two providers disappear, the remaining providers still contain enough information to reconstruct the original file. Prime Server then rebuilds the lost shards and records the recovery on Flare.
