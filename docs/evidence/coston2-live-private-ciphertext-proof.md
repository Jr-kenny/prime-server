# Prime Server Coston2 live private ciphertext proof

Status: passed against the frozen `PrimeServerRegistry` deployment.

The registry source, ABI, storage layout, and deployment were left unchanged. The proof used the existing registry interface for normal user blob, payment, policy, access, provider, and recovery state transitions.

## Frozen registry

- Address: `0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1`
- Chain ID: `114`
- Deployment block: `33590506`
- Deployment transaction: `0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e`
- Runtime bytecode: `24,355` bytes

Command:

```bash
node scripts/coston2-private-ciphertext-demo.mjs
```

Run: `coston2-private-1785788401731-62772`

Machine evidence: `.prime-server/evidence/coston2/coston2-private-1785788401731-62772.json`

The run used four local provider processes and four funded Coston2 provider wallets. The owner and selected-wallet accounts were generated for this run and funded from the configured deployer. Private keys, plaintext bytes, file keys, and envelope contents were not written to the repository evidence.

## Private encrypted upload

The client generated a 1 MiB plaintext, encrypted it locally with AES-256-GCM, sealed the filename and metadata in the FCC envelope format, then Clay-encoded the ciphertext. The original filename never entered the onchain name.

- Blob ID: `0x74c1871f16da62c47b57870df3eb16552972db4d00cf910ea17d777008f02c6d`
- Onchain name: `private/74c1871f16da62c47b57870df3eb16552972db4d00cf910ea17d777008f02c6d`
- Opaque onchain name: `true`
- Source filename absent from onchain name: `true`
- Plaintext size: `1,048,576` bytes
- Ciphertext size: `1,048,604` bytes
- Paid registration: `0xa2777d283cabf586995ce8a7965fc060761c77e9c2068ed587d43e11335911d8`
- Plaintext SHA-256: `71e54e6b455f35337fa9edd808f84758d0d01b33de156ed5bc09c0b1ad2bf137`
- Ciphertext SHA-256: `739f683137be0e90bd797edfda57b3b616249d2b92a0e83b966ddd527b267986`
- Ciphertext differs from plaintext: `true`

Commitments prepared locally and read back from the frozen registry matched:

- Clay ciphertext commitment: `0x595db1a28c971a15d9520a0f39d1fe74c872a771a2e0116669f8fe59bb0f129c`
- Policy commitment: `0xefbd92ca6edb44c9b2dc3f94caab2513d65d0d855f5aea3d944aac36664b5b87`
- Key-envelope commitment: `0xda533619b06b63e9c7c822ba6a45187ec5419e1352bd7a952dcd448d26c42679`
- Metadata commitment: `0x9161179418371e43cca245879920fadc27fabed7c8d079d9ef67605eb2b15b90`
- Onchain policy: `private / selected_wallets`
- Envelope and metadata commitments matched onchain: `true`

The owner download returned the ciphertext hash above. It did not return the plaintext.

## Selected-wallet retrieval

The owner authorized a second wallet through `setBlobWalletAccess`, then the second wallet signed a fresh EIP-712, device-bound view intent.

- Selected wallet: `0x518d5737DB52e4C07D455a851789F22E0AdAF90f`
- Owner access transaction: `0xa8fcf58719e335a26f1cec68f3bfaa30d8a49d02cbe23db9dbf228a23f887b61`
- Access request ID: `0x0f745781812c96368fedfc3390702dec15a07086073b513cbd1f64a6421d96fa`
- Access authorization transaction: `0xc3a27a126486fbda43977eb98866f2a6606aa5dbfff86a9913bf29f2976a9403`
- Device-key commitment: `0x74853089bc102fe9ef54d90715daf96d38194aa38c4ce961bb160fb75bc4a6a1`
- Onchain access usable: `true`

The selected wallet retrieved the object through the owner-scoped ciphertext route both before and after recovery:

- Response status before recovery: `200`
- Response status after recovery: `200`
- Returned SHA-256 before and after recovery: `739f683137be0e90bd797edfda57b3b616249d2b92a0e83b966ddd527b267986`
- Returned bytes equal ciphertext: `true`
- RPC released plaintext: `false`

## Provider failure and ciphertext recovery

After the initial upload, providers 2 and 4 were stopped. The RPC reconstructed the ciphertext from the two surviving shards, reporting missing shards 1 and 3. Those shard files were then removed, the provider processes were restarted, and the recovery API rebuilt both ciphertext shards.

- Failed providers: `provider-2`, `provider-4`
- Missing shards: `1`, `3`
- Recovery start transactions:
  - shard 1: `0x6e7a799310ea8faf65c387a99535477d350724f65d51c31e9a8f8c1155e7abd1`
  - shard 3: `0x6489cfce272b643a27e434e22f7845075352352ee4fed01d88cfa964315e45cd`
- Reassignment transactions:
  - shard 1: `0x43fe282b61de13f1df5535b9a171edd621c741d3ee24377553ed4f31492ee0f6`
  - shard 3: `0xa7ffcbe7c267a7a94ea48265d8aa99dacf0829ae8794044035b57f3e4a1c4083`
- Rebuilt shard transactions:
  - shard 1: `0xe31f0e0f837d6abbf5b7d8a4cbfd8f7d94842a4ae22c5ccfaad38b39972be952`
  - shard 3: `0x23189098734818be82ff9731ee1f41cfa7503d68a4bbd4ec98bd3b66f6155b1f`
- RPC recovery read reported `x-prime-recovered: true`
- Recovery ciphertext SHA-256: `739f683137be0e90bd797edfda57b3b616249d2b92a0e83b966ddd527b267986`
- Final blob status: `rebuilt`
- Final acknowledgement count: `4`

Every provider shard was checked through its provider endpoint. No stored or rebuilt shard equaled the plaintext, and no shard contained the complete plaintext. The final reconstructed ciphertext matched the original ciphertext byte for byte.

Local decryption of the final recovered ciphertext produced:

- Final decrypted plaintext SHA-256: `71e54e6b455f35337fa9edd808f84758d0d01b33de156ed5bc09c0b1ad2bf137`
- Final decrypted hash matches original plaintext: `true`

The native paid private blob remained `partially_settled` because the registry keeps its expiry reserve escrowed. This proof does not claim expiry settlement.

## Confidential compute-only guard

The same run registered and uploaded a second encrypted blob with `confidential / compute_only` policy. No FCC compute result was supplied.

- Blob ID: `0x23897465ce6f78975a2e1f0f598b84260c7273d441c679e078cab205f3daa081`
- Registration transaction: `0x7479c3fe860e2573aacf268e6f84ab94d70a39b9471548da8dc85fbcc2a19cb7`
- Raw `/v1/blobs/:blobId/content` status: `403`
- Owner developer download status: `403`
- Error: `compute-only blobs require an FCC access result`
- Plaintext released: `false`

This completes the live private ciphertext, selected-wallet retrieval, provider failure, ciphertext recovery, local decryption, and compute-only download guard proof. Live FCC key rewrap, TEE attestation, confidential compute, XRP/FDC/FAssets settlement, and explorer UI remain separate slices.
