<div align="center">

# Prime Server

**Wallet-owned, verifiable blob storage on Flare.**

Prime Server gives applications a storage endpoint backed by wallet-signed registrations, independent provider processes, erasure-coded shards, and an onchain recovery record.

[Architecture](./architecture.md) · [Developer API](./docs/developer-api.md) · [Explorer UI](./ui/) · [Coston2 registry](https://coston2-explorer.flare.network/address/0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1)

![Flare](https://img.shields.io/badge/Flare-Coston2-2563eb?style=flat-square&logo=ethereum&logoColor=white)
![Storage](https://img.shields.io/badge/Storage-2--of--4-3978e8?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Node.js-315da7?style=flat-square)

</div>

---

## What it is

Prime Server is a storage network for applications that need more than an upload endpoint. The application computes a blob commitment locally, the user wallet registers that commitment on Flare, and Prime RPC accepts bytes only after it has read and verified the registration.

The coordinator can assign providers, verify acknowledgements, start recovery, and finalize storage. It cannot invent a user-owned blob. Ownership comes from the wallet transaction that calls the registry.

The first provider profile uses four shards and needs any two data shards to reconstruct the object. A failed provider can be replaced without changing the blob ID or its registered commitment.

```text
Application
    |
    | prepare bytes, encrypt locally when required, compute commitment
    v
User wallet -> Prime Server Registry on Flare
    |
    | owner, name, size, expiry, policy, payment, commitment
    v
Prime RPC verifies the registration before accepting the body
    |
    | distributes four shards and checks provider acknowledgements
    v
Provider 1   Provider 2   Provider 3   Provider 4
    \             |             |             /
     `------ registry finalization and recovery ------'
```

The important boundary is simple: the chain records what the user registered, and the storage service has to prove that the bytes it received match it.

## The path a blob takes

A public upload looks like this:

1. The application prepares the file locally and gets a blob ID, size, expiry, shard configuration, and root commitment.
2. The connected wallet calls `createBlobNamed` on the Prime Server Registry.
3. The client waits for the successful Coston2 receipt.
4. The application authenticates to Prime RPC with a signed wallet challenge.
5. Prime RPC reads the pending registration, checks the owner and metadata, recomputes the commitment, and rejects a mismatch.
6. The RPC sends the four encoded shards to their assigned providers.
7. Provider acknowledgements are recorded on Flare.
8. The registry reaches `Active`, and later recovery events can be followed from the same blob ID.

For paid storage, `createBlobNamedPaid` quotes native Coston2 value and sends payment plus registration in one wallet transaction. The provider pool pays immediate placement claims, while the retention reserve stays locked until expiry.

## The developer surface

Applications use `/prime/v1` for wallet sessions, named blobs, listing, metadata, downloads, and range requests.

```text
GET  /prime/v1/auth/challenge?address=0x...
POST /prime/v1/auth/session
GET  /prime/v1/account
PUT  /prime/v1/blobs/:account/:name
GET  /prime/v1/blobs/:account/:name
HEAD /prime/v1/blobs/:account/:name
GET  /prime/v1/blobs/:account
```

The HTTP session protects API access and upload bandwidth. It does not create the blob and it does not decide who owns it.

The JavaScript client keeps the registration and upload sequence together:

```js
import { PrimeServerClient } from "@prime-server/sdk";

const prime = new PrimeServerClient({
  baseUrl: "https://api.primeserver.example/prime/v1",
  wallet: {
    address: walletAddress,
    signMessage: ({ message }) => walletClient.signMessage({ message })
  },
  walletClient,
  publicClient,
  registryAddress: "0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1"
});

const prepared = await prime.prepareBlob(bytes, {
  name: "reports/hello.txt",
  expirationSeconds: 86_400
});

await prime.registerBlob(prepared);
await prime.uploadRegisteredBlob(prepared, bytes, {
  contentType: "text/plain"
});
```

The same client supports native paid registration, owner-scoped listing, `HEAD` metadata, full reads, byte ranges, encrypted preparation, device-bound access requests, and selected-wallet ciphertext retrieval.

## Private storage

Private and confidential blobs use the same provider network. The browser encrypts the file before it is encoded. Prime RPC and the providers receive ciphertext, not the original bytes.

```text
Original file
    |
    | AES-256-GCM in the client
    v
Ciphertext and sealed metadata
    |
    | local erasure encoding and commitment
    v
Wallet registration on Flare
    |
    v
Four ciphertext shards across providers
```

The private flow uses an opaque onchain name. The original filename and metadata stay in the sealed envelope, while the policy, metadata, and key-envelope commitments are recorded with the blob.

The same wallet can request ciphertext from another device. The device creates a temporary key pair, the wallet signs a fresh access intent, and an FCC controller can rewrap the file key to that device after the live extension and attestation path is configured. The browser performs the final decryption.

Confidential storage uses the same encrypted path with `compute_only` access. Raw downloads are rejected for that mode. A local FCC extension can prove the key-package and compute payload behavior, but live TEE attestation and confidential compute remain separate deployment work.

## The live proof

The current frozen registry is deployed on Flare Coston2:

| Field | Value |
| --- | --- |
| Network | Flare Coston2 |
| Chain ID | `114` |
| Registry | [`0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1`](https://coston2-explorer.flare.network/address/0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1) |
| Deployment block | `33590506` |
| Deployment transaction | [`0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e`](https://coston2-explorer.flare.network/tx/0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e) |
| Runtime bytecode | `24,355` bytes |

The latest private ciphertext proof passed against this frozen address. It used a 1 MiB plaintext, encrypted it locally, stored only ciphertext through the RPC and providers, stopped providers 2 and 4, rebuilt the missing ciphertext shards, retrieved the ciphertext with a selected-wallet access request, and decrypted the recovered bytes locally. The final plaintext hash matched the original hash, and compute-only raw download returned `403`.

The machine-readable proof and exact hashes are in [docs/evidence/coston2-live-private-ciphertext-proof.md](./docs/evidence/coston2-live-private-ciphertext-proof.md).

The final frozen-registry proof also covers provider failure, shard reconstruction, reassignment, expiry reserve settlement, and the full provider pool reaching `Settled`. The original provider receives its immediate reward once, and the replacement provider receives only the reserve for the reassigned shard. See [docs/evidence/coston2-live-provider-recovery-settlement-proof.md](./docs/evidence/coston2-live-provider-recovery-settlement-proof.md).

## The explorer

The React explorer is the product surface for the protocol. It exposes:

- overview totals and current registry source;
- named blobs, owners, commitments, status, and expiry;
- chain events for registration, placement, acknowledgement, payment, recovery, and finalization;
- provider operators, endpoints, registration blocks, and status;
- recovery topology and failed-shard activity;
- per-blob placement details and transaction links;
- an in-app developer documentation page with the HTTP API, SDK, privacy, provider, payment, contract, and limit references.

The UI environment is configured for the frozen Coston2 registry in [ui/.env.example](./ui/.env.example). Registry state is read from the Coston2 RPC and event history comes from the public Coston2 explorer index. The UI shows both the current chain head and the block through which the event index is synced. Preview data is clearly labeled. Set `VITE_DEMO_MODE=false` when reading the live registry.

## Start here

- [architecture.md](./architecture.md) explains the storage, payment, privacy, FCC, and recovery boundaries.
- [docs/developer-api.md](./docs/developer-api.md) defines the registration-first HTTP and JavaScript client surface.
- [sdk/README.md](./sdk/README.md) shows the developer client flow.
- [SLICES.md](./SLICES.md) is the current execution queue.
- [docs/demo-script.md](./docs/demo-script.md) explains the live provider and recovery demonstration.
- [docs/evidence/coston2-live-private-ciphertext-proof.md](./docs/evidence/coston2-live-private-ciphertext-proof.md) records the frozen-registry private proof.
- [docs/evidence/coston2-live-provider-recovery-settlement-proof.md](./docs/evidence/coston2-live-provider-recovery-settlement-proof.md) records the final-registry provider recovery and paid settlement proof.
- [docs/evidence/coston2-settlement-reassignment-fix-deployment.md](./docs/evidence/coston2-settlement-reassignment-fix-deployment.md) records the final registry deployment and settlement regression.
- [contracts/src/PrimeServerRegistry.sol](./contracts/src/PrimeServerRegistry.sol) is the onchain lifecycle and payment surface.
- [REQUESTED_INPUTS.md](./REQUESTED_INPUTS.md) lists the local credentials and software needed for live slices.

## Repository map

```text
contracts/   Prime Server Registry, payment state, policy fields, and recovery logic
provider/    Provider daemon, shard storage, reads, range reads, and acknowledgements
rpc/         Prime RPC, wallet sessions, registration checks, placement, and recovery
sdk/         JavaScript client for the developer API
fcc/         FCC envelope, access, key-package, and compute extension tests
ui/          React explorer, wallet upload flow, and in-app developer docs
scripts/     Local providers, deployment helpers, and Coston2 proof orchestration
docs/        API reference, architecture notes, demo instructions, and evidence
test/        Cross-component and provider-harness tests
```

## Run the product UI

The explorer and wallet upload flow live in `ui/`. The tracked environment example points to the frozen Coston2 registry and deployment block.

```bash
git clone https://github.com/Jr-kenny/prime-server
cd prime-server/ui
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL shown in the terminal. The live explorer reads the registry directly from Coston2. The upload flow also needs Prime RPC at the URL in `VITE_PRIME_RPC_URL`.

## Run the Coston2 proofs

The proof scripts use the ignored root `.env` for the Coston2 RPC, deployment account, provider accounts, registry address, and authentication secret. Never commit those values.

The core provider failure and recovery path is:

```bash
node scripts/coston2-demo.mjs
```

The paid reassignment and expiry reserve path is:

```bash
node scripts/coston2-settlement-reassignment-demo.mjs
```

The private ciphertext path is:

```bash
node scripts/coston2-private-ciphertext-demo.mjs
```

Each run starts isolated local provider processes, writes the chain transactions, checks the provider and registry state, and saves machine-readable evidence under `.prime-server/evidence/coston2/`.

## Verification

Run the relevant gates from each package:

```bash
cd contracts && forge test -vvv
cd ../rpc && npm install && npm test
cd ../provider && npm install && npm test
cd ../sdk && npm install && npm test
cd ../fcc && npm install && npm test
cd ../ui && npm install && npm run build
```

The project keeps its proof boundary explicit:

| State | Meaning |
| --- | --- |
| Implemented | The code path exists in the repository. |
| Locally verified | Unit, package, local EVM, or local provider tests pass. |
| Live proof | A real Coston2 run produced receipts, provider state, and matching content evidence. |
| Pending | The path still needs its own deployment, attestation, or end-to-end run. |

## Current boundary

The storage core, wallet-owned registration, provider acknowledgements, local recovery, native paid registration, encrypted ciphertext preparation, selected-wallet ciphertext retrieval, and explorer surface are in the repository.

The following remain separate proof slices:

- live FCC extension registration and TEE attestation;
- same-wallet second-device key rewrap through the official FCC result path;
- live confidential compute;
- XRP, FDC, and FAssets settlement;
- efficient shard-range retrieval instead of full reconstruction followed by HTTP slicing;
- multipart uploads and S3 compatibility.

Prime Server does not call those paths complete until the live evidence exists.
