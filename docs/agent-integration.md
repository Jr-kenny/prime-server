# Prime Server integration guide for developers and agents

This guide is written for a developer, script, or AI agent that needs to
discover the service and store a blob without guessing at ownership or
privacy state.

The public API is rooted at `/prime/v1`. The current implementation runs on
Flare Coston2, chain ID `114`, and uses a four-provider, 2-of-4 erasure
profile. The current first chunkset accepts up to 2 MiB.

## 1. Discover the service

Start with process health and capability discovery:

```
curl https://your-prime-server.example/health
curl https://your-prime-server.example/prime/v1
```

The capability response is the source for feature checks. In particular,
check `registrationRequired`, `payments`, `encryptedStorage`, and
`confidentialCompute` before showing a feature in an agent workflow.

The machine-readable contract is
[openapi.yaml](./openapi.yaml). The human API reference is
[developer-api.md](./developer-api.md).

## 2. Prepare bytes locally

Use `@prime-server/sdk` when the application is JavaScript or TypeScript.
`prepareBlob` computes the blob ID, commitment, size, expiry, and shard
parameters before any chain write.

```
const prepared = await prime.prepareBlob(bytes, {
  name: "reports/hello.txt",
  expirationSeconds: 86_400
});
```

Keep the prepared record and the exact byte sequence together. Do not
re-encode, transform, or change the name between preparation, registration,
and upload.

For private or confidential storage, encrypt before preparation:

```
const prepared = await prime.prepareEncryptedBlob(bytes, {
  name: "reports/private.json",
  storageMode: "private",
  accessPolicy: "owner_only",
  fccPublicKey: teePublicKey,
  expirationSeconds: 86_400
});
```

Providers and Prime RPC receive ciphertext for private and confidential
objects. Keep the plaintext key in the authorized client boundary.

## 3. Register with the owner wallet

The owner wallet must call the configured registry before the API accepts
bytes:

```
await prime.registerBlob(prepared);
```

For a paid public, private, or confidential object:

```
await prime.registerPaidBlob(prepared, {
  storageMode: "public",
  accessPolicy: "owner_only"
});
```

The transaction receipt is the ownership proof. A Prime API session does not
create a blob and cannot replace the wallet registration.

Agents should present the transaction and payment details to the user before
asking for a signature. Never submit a chain write or approve a payment
without explicit user approval.

## 4. Authenticate the API session

The client signs a short-lived challenge with the same wallet that owns the
registration:

```
GET  /prime/v1/auth/challenge?address=0x...
POST /prime/v1/auth/session
GET  /prime/v1/account
```

Send the returned token as:

```
Authorization: Bearer <token>
```

The session account must match the registered owner. The API refuses
cross-account uploads.

## 5. Upload the exact registered bytes

The SDK keeps the cross-check headers in sync:

```
await prime.uploadRegisteredBlob(prepared, bytes, {
  contentType: "text/plain"
});
```

An HTTP client must send the registration metadata explicitly:

```
curl -X PUT \
  "https://your-prime-server.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
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

The gateway verifies the owner, name, pending status, expiry, size, encoding,
payment state, policy commitments, and recomputed commitment before sending
shards to providers.

## 6. Verify the result

Use the returned object, then verify metadata and content:

```
curl -I \
  "https://your-prime-server.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN"

curl \
  "https://your-prime-server.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \
  -H "Authorization: Bearer $PRIME_TOKEN" \
  -H "Range: bytes=0-1023"
```

Useful states are `pending`, `active`, `recovering`, and
`expired`. A successful HTTP response proves the API path completed. The
explorer and registry events provide the chain-side placement and recovery
record.

Blob rows in the explorer open an in-app record with the blob ID, commitment,
policy, provider placements, acknowledgements, and transaction link. Provider
rows open their registry identity and advertised endpoint. Registry status and
an endpoint health check remain separate signals.

## 7. Privacy and confidential compute

Private storage allows authorized ciphertext retrieval. Confidential storage
uses `compute_only` access and blocks raw downloads. Use the capability
response before exposing either workflow.

The optional read-only FCC proxy routes are:

```
GET /prime/v1/fcc/info
GET /prime/v1/fcc/result/{instructionId}
```

These routes require a Prime session. A result can remain `202 pending`. A
configured route does not, by itself, prove that an attested Coston2 result
has completed. The current repository keeps the official proxy, indexer, TEE
registration, sender, verifier, and live evidence boundary explicit.

## 8. Provider operators

The first upload path has exactly four provider slots. A deployment can use
local providers, remote public HTTPS providers, or a mix of both:

```
PRIME_SERVER_PROVIDER_1_URL=https://provider-one.example
PRIME_SERVER_PROVIDER_2_URL=https://provider-two.example
```

Each remote endpoint must expose `/health` and the provider shard routes.
The corresponding provider operator key is still required for registry
identity and registration. A fifth provider is a protocol and placement
change, not a configuration-only addition.

## Error handling

Agents should stop and surface the error when they receive:

- `400`, because request headers, bytes, or names are invalid.
- `401`, because the session is missing or expired.
- `403`, because the wallet or privacy policy denies the action.
- `404`, because the registration, object, or FCC route is unavailable.
- `409`, because the name or registration state has changed.
- `410`, because the object or registration expired.
- `416`, because a requested byte range is invalid.
- `503`, because a required service or confidential extension is not
  configured.

Do not retry a chain registration or payment automatically after a timeout.
First inspect the transaction hash or wallet history, then check the registry
and object state.
