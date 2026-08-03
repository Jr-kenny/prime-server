# Prime Server developer API

Prime Server exposes a wallet-owned blob API at `/prime/v1`. The gateway hides provider placement, erasure coding, Flare transactions, acknowledgements, and recovery behind a normal HTTP interface.

The live public base URL will be configured as:

```text
https://api.primeserver.<your-domain>/prime/v1
```

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

The gateway verifies the wallet signature before accepting writes. The Flare registry records that wallet as the blob owner. The coordinator wallet is allowed to carry out placement and recovery transactions on behalf of the owner.

## Blob API

```text
PUT  /blobs/{account}/{blobName}
GET  /blobs/{account}/{blobName}
HEAD /blobs/{account}/{blobName}
GET  /blobs/{account}
```

Blob names can contain `/`, can be up to 1024 UTF-8 bytes, and can’t end in `/`. Clients URL encode the name. Every upload must include one of these headers:

```http
x-prime-expires-at: 1780000000
x-prime-expiration-seconds: 86400
```

Example upload:

```bash
curl -X PUT \
  "https://api.primeserver.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-prime-expiration-seconds: 86400" \
  --data-binary @hello.txt
```

Example range read:

```bash
curl \
  "https://api.primeserver.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN" \
  -H "Range: bytes=0-1023"
```

The response includes the Prime blob ID, commitment, owner-scoped name hash, expiration, ETag, and recovery headers. The Flare registry stores the owner, name hash, full blob name, commitment, placement, acknowledgements, and lifecycle state. This lets a developer recover the identity of a named blob from chain state instead of trusting only the gateway’s local index.

## JavaScript client

The repository includes `@prime-server/sdk`:

```js
import { PrimeServerClient } from "@prime-server/sdk";

const prime = new PrimeServerClient({
  baseUrl: "https://api.primeserver.example/prime/v1",
  wallet: {
    address: walletAddress,
    signMessage: ({ message }) => walletClient.signMessage({ message })
  }
});

await prime.put("reports/hello.txt", Buffer.from("hello"), {
  expirationSeconds: 86_400,
  contentType: "text/plain"
});

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
```

## Product boundary

The legacy `/v1/blobs` endpoints remain available for the internal proof harness. External applications should use `/prime/v1`, because that surface carries wallet ownership and named objects.
