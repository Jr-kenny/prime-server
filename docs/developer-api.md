# Prime Server developer API

Prime Server exposes a developer-facing blob API at `/prime/v1`. Public writes keep ownership on Flare. The client prepares and registers the blob with the user wallet, then Prime RPC verifies that registration before it accepts the original bytes.

Use [openapi.yaml](./openapi.yaml) for generated clients and schema-aware tools. Use [agent-integration.md](./agent-integration.md) for the safe discovery, wallet approval, upload, verification, privacy, and provider sequence.

The current implementation is Coston2 testnet infrastructure. It supports one-shot blobs up to 2 MiB, wallet sessions, object names, listing, metadata, full downloads, byte ranges, native paid registration, encrypted storage preparation, policy commitments, and the FCC compute request and result routes. Multipart uploads, S3 compatibility, cross-chain payment settlement, and the live simulated-TEE evidence run remain separate proof slices.

## Authentication

Clients authenticate by signing a short-lived Prime Server login message with the wallet that owns the account.

```text
GET  /auth/challenge?address=0x...
POST /auth/session
GET  /account
```

The session token is sent as:

```http
Authorization: Bearer <token>
```

The session proves that the caller may use the API. It supports rate limiting and account-scoped API access. It does not authorize ownership and it does not create the blob. Ownership comes from the wallet transaction that calls `createBlobNamed` or `createBlobNamedPaid` on the configured registry.

## Blob API

```text
PUT  /blobs/{account}/{blobName}
GET  /blobs/{account}/{blobName}
HEAD /blobs/{account}/{blobName}
GET  /blobs/{account}
```

Blob names can contain `/`, can be up to 1024 UTF-8 bytes, and can’t end in `/`. Clients URL encode the name.

The blob must already be registered by the wallet. A raw HTTP upload cannot create a user-owned blob. The upload includes the registration metadata so the gateway can reject mismatched requests before distributing shards:

```http
x-prime-blob-id: 0x...
x-prime-commitment: 0x...
x-prime-chunk-size: 1048576
x-prime-data-shards: 2
x-prime-total-shards: 4
x-prime-expires-at: 1780000000
```

Paid uploads add the policy and payment cross-checks:

```http
x-prime-storage-mode: 0
x-prime-access-policy: 0
x-prime-policy-commitment: 0x...
x-prime-key-envelope-commitment: 0x0000000000000000000000000000000000000000000000000000000000000000
x-prime-metadata-commitment: 0x0000000000000000000000000000000000000000000000000000000000000000
```

The paid wallet transaction quotes native Flare from the registry and sends the payment together with the blob registration. The quote includes the registered storage duration and storage-mode multiplier. Prime RPC accepts the upload only while the registry payment is escrowed. Finalization makes the immediate provider rewards claimable, while a retention reserve stays escrowed until the blob expires. Providers can claim that reserve after expiry, and the protocol fee becomes withdrawable only after the full provider pool is settled.

Example registration-first request after `createBlobNamed` confirms:

```bash
curl -X PUT \
  "https://api.primeserver.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-prime-blob-id: 0xRegisteredBlobId" \
  -H "x-prime-commitment: 0xRegisteredCommitment" \
  -H "x-prime-chunk-size: 1048576" \
  -H "x-prime-data-shards: 2" \
  -H "x-prime-total-shards: 4" \
  -H "x-prime-expires-at: 1780000000" \
  --data-binary @hello.txt
```

Before accepting bytes, RPC reads the registration and verifies the blob ID, user origin, owner, name, pending status, size, expiry, supported encoding parameters, and locally recomputed commitment. It then assigns shards, verifies provider acknowledgements, and finalizes the blob.

Example range read:

```bash
curl \
  "https://api.primeserver.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN" \
  -H "Range: bytes=0-1023"
```

The response includes the Prime blob ID, commitment, owner-scoped name hash, origin, expiration, storage mode, access policy, payment status, ETag, and recovery headers. The Flare registry stores the owner, name hash, full blob name, commitment, placement, acknowledgements, policy, payment, and lifecycle state.

Private storage

The SDK encrypts the file locally with AES-256-GCM before it prepares the Clay commitment. The provider and RPC receive only the ciphertext. Private and confidential preparations replace the supplied public filename with an opaque `private/<blobId>` name. The original filename and content type are included inside the encrypted metadata payload, and the metadata commitment is recorded on Flare. A sealed key envelope is committed on Flare and is consumed by the FCC extension. `confidentialCompute` accepts a narrow operation, waits for the signed FCC result, and submits it through the result verifier. The live TEE result still requires the official Coston2 extension registration and attestation flow.

Selected wallets can retrieve ciphertext through the owner-scoped route after presenting an active, wallet-signed view access request in `x-prime-access-request-id`. The route returns ciphertext only. The SDK exposes this as `prime.get(name, { account: owner, accessRequestId })`. Confidential storage uses the same encrypted upload path with `compute_only` access. The gateway refuses raw reads for those blobs. The wallet can create a fresh EIP-712 access intent bound to a temporary device public-key commitment. The registry enforces the wallet authorization, nonce, deadline, blob expiry, revocation state, and current wallet authorization. An FCC controller must consume the intent with a response commitment before a future compute result can be released.

## JavaScript client

The repository includes `@prime-server/sdk`:

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
  registryAddress: "0xRegistryAddress"
});

const bytes = Buffer.from("hello");
const prepared = await prime.prepareBlob(bytes, {
  name: "reports/hello.txt",
  expirationSeconds: 86_400
});
await prime.registerBlob(prepared);
await prime.uploadRegisteredBlob(prepared, bytes, { contentType: "text/plain" });

const paidPrepared = await prime.prepareBlob(bytes, {
  name: "reports/paid.txt",
  expirationSeconds: 86_400
});
await prime.registerPaidBlob(paidPrepared, {
  storageMode: "public",
  accessPolicy: "owner_only"
});
await prime.uploadRegisteredBlob(paidPrepared, bytes, { contentType: "text/plain" });

const encrypted = await prime.prepareEncryptedBlob(bytes, {
  name: "private.bin",
  storageMode: "private",
  accessPolicy: "owner_only",
  fccPublicKey: teePublicKey,
  expirationSeconds: 86_400
});
await prime.registerPaidBlob(encrypted);
await prime.uploadRegisteredBlob(encrypted, encrypted.ciphertext);

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
const selectedCiphertext = await prime.get(encrypted.name, {
  account: ownerAddress,
  accessRequestId: accessRequestId
});
```

`prime.put(...)` is a convenience wrapper around preparation, direct registration, and registered upload. Pass `paid: true` for native paid registration, or use `prime.putPaid(...)`. Encrypted preparations are uploaded with `encrypted.ciphertext`, not the original plaintext. The SDK requires a wallet client, public client, and registry address because the upload must wait for a successful onchain registration receipt.

## Product boundary

The legacy `/v1/blobs` endpoints remain available for the internal proof harness. External applications should use `/prime/v1`, because that surface exposes registration-first wallet ownership and named objects.
