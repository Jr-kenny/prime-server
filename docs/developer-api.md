# Prime Server developer API

Prime Server exposes a developer-facing blob API at `/prime/v1`. Public writes keep ownership on Flare. The client prepares and registers the blob with the user wallet, then Prime RPC verifies that registration before it accepts the original bytes.

The current implementation is Coston2 testnet infrastructure. It supports one-shot blobs up to 2 MiB, wallet sessions, object names, listing, metadata, full downloads, and byte ranges. Multipart uploads, S3 compatibility, and payment sessions are planned follow-up slices.

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

The session proves that the caller may use the API. It supports rate limiting and account-scoped API access. It does not authorize ownership and it does not create the blob. Ownership comes from the wallet transaction that calls `createBlobNamed` on the configured registry.

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

The response includes the Prime blob ID, commitment, owner-scoped name hash, origin, expiration, ETag, and recovery headers. The Flare registry stores the owner, name hash, full blob name, commitment, placement, acknowledgements, and lifecycle state.

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

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
```

`prime.put(...)` is a convenience wrapper around preparation, direct registration, and registered upload. The SDK requires a wallet client, public client, and registry address because the upload must wait for a successful onchain registration receipt.

## Product boundary

The legacy `/v1/blobs` endpoints remain available for the internal proof harness. External applications should use `/prime/v1`, because that surface exposes registration-first wallet ownership and named objects.
