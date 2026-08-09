# Prime Server Coston2 historical paid and policy proof

Recorded on 2026-08-03 from the local Prime Server checkout.

This run proves the new native paid and policy layers against a fresh Coston2 registry. It does not claim XRP settlement, live FCC key release, TEE attestation, or confidential compute.

This is a historical pre-hardening paid proof. The final frozen-registry paid, recovery, and settlement proof is in [coston2-live-provider-recovery-settlement-proof.md](./coston2-live-provider-recovery-settlement-proof.md). The final private and access proof is in [coston2-live-private-ciphertext-proof.md](./coston2-live-private-ciphertext-proof.md).

## Deployment

| Field | Value |
| --- | --- |
| Chain ID | `114` |
| Registry | `0x73f92b133e6259f170Bc42FA708F476CDE15AdD0` |
| Deployment block | `33585089` |
| Deployment transaction | `0x8bb3a8133c1092771f7cc5202a8d39fae312c5014dba1e1ef96213b053b6f520` |
| Compiler | Solidity `0.8.24`, via-IR |
| Deployed runtime bytecode | `23,489` bytes |
| Deployment receipt | success |

The runtime is below the EIP-170 limit of 24,576 bytes. The ignored local `.env` points the Prime RPC proof harness at this registry.

## Public native paid blob

| Field | Value |
| --- | --- |
| Run ID | `coston2-paid-1785771475388-22425` |
| User wallet | `0xd67Dd6CcF9680B612E1EF0c16D5edc3ba9D860C5` |
| Blob ID | `0x7055c5dd3389f47474a21ed571ff43215b342b2160d49c16f4885a8f976b4cd7` |
| Blob name | `paid/public-coston2-paid-1785771475388-22425.bin` |
| Registration transaction | `0xbebe7ca2d6cbbd2bc3441a7f6ea34c5b540197f10e28afdab4454fb85c8d210d` |
| Blob commitment | `0xe94901a2978576b8fa3363012a3a73822d65b84a9c3083b1b009285973e7f492` |
| Native quote | `4,200,000,000,000 wei` |
| Provider pool | `4,000,000,000,000 wei` |
| Protocol fee | `200,000,000,000 wei` |
| Upload status | `active` |
| Payment status | `settled` |
| Provider claims | `4`, one per final placement shard |
| Input SHA-256 | `ac6533c30d2d4fcc01be82be68bd63a592d37c49fe769b05aebfb4504fa146b3` |
| Downloaded SHA-256 | `ac6533c30d2d4fcc01be82be68bd63a592d37c49fe769b05aebfb4504fa146b3` |
| Range response | `206` |

The wallet paid and called `createBlobNamedPaid` in one transaction. Prime RPC read the registration from Flare, verified the policy and payment state, stored four acknowledged shards, finalized the blob, and submitted four provider settlement claims. The download and range read matched the uploaded bytes.

## Private ciphertext blob

| Field | Value |
| --- | --- |
| Blob ID | `0xe0fb62d8a16d20c026be37685898518bf3510b9035b9789ae98795937a43c097` |
| Blob name | `opaque/private-coston2-paid-1785771475388-22425.bin` |
| Registration transaction | `0x0743b4b5866d4fb4dce4817eba6bd3fee4125b4ae697c990fd8383362fd6062b` |
| Storage mode read from Flare | `private` |
| Original bytes | `57` |
| Ciphertext bytes | `85` |
| Payment status | `settled` |
| Provider claims | `4` |
| Plaintext SHA-256 | `01deb30772f39624671fe2946b99a387b120fcc29ea9a6d3f8e67e36853e8284` |
| Locally decrypted SHA-256 | `01deb30772f39624671fe2946b99a387b120fcc29ea9a6d3f8e67e36853e8284` |
| FCC envelope commitment | `0x3c4735abb09fe7a053e707de95610e1c6c05491fc796dbaf0a8d0f24760a529b` |

The client encrypted before Clay preparation. The provider and RPC handled the ciphertext blob. The browser-side SDK decrypted the downloaded ciphertext using the in-memory key. The envelope was prepared and committed, but no live FCC TEE release was claimed.

## Wallet access intent

| Field | Value |
| --- | --- |
| Request ID | `0xd8d68d909b9f62a697680fa277430c64b76a1af77d5088d1f496e3e514941a80` |
| Authorization transaction | `0x9d7f34c9cc0a63751d3cf643488121ec154159e2f76557d36c70d895fb077889` |
| Requester | `0xd67Dd6CcF9680B612E1EF0c16D5edc3ba9D860C5` |
| Purpose | `View` |
| Nonce | `0` |
| Onchain request state | usable |
| FCC consumed | false |
| Attestation verified | false |

The wallet signed a fresh EIP-712 request bound to a temporary device-key commitment. The registry accepted it and advanced the nonce. The request was intentionally left unconsumed because no live FCC controller or attestation was used in this run.

## Event evidence

The event indexer read the following events from the run tip:

| Event | Count |
| --- | ---: |
| `BlobCreated` | 2 |
| `BlobNamed` | 2 |
| `BlobPolicyRecorded` | 2 |
| `PaymentEscrowed` | 2 |
| `ShardAssigned` | 8 |
| `ShardAcknowledged` | 8 |
| `BlobFinalized` | 2 |
| `ProviderSettlementClaimed` | 8 |
| `ConfidentialAccessAuthorized` | 1 |

The complete machine-readable record is `.prime-server/evidence/coston2/coston2-paid-1785771475388-22425.json`. It remains ignored by Git because it includes local provider paths and temporary runtime details.
