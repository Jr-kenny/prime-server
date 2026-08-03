# Prime Server Coston2 live proof

Recorded on 2026-08-03 from the local Prime Server checkout.

This is a real four-process storage proof on Flare Coston2. The provider endpoints in this run use loopback addresses on the Mac. They prove process isolation and the protocol lifecycle. They are not public storage endpoints.

## Deployment

| Field | Value |
| --- | --- |
| Chain ID | `114` |
| Registry | `0x9864476bFFBe1d261419Bc6b1b6ec3c00CF65325` |
| Deployment block | `33577929` |
| Deployment transaction | `0x31c302a9c7985dbbd42625b5439f3045135ee9dd0bfe7de313131c6c931701f6` |
| Compiler | Solidity `0.8.24` |
| Deployed bytecode | `7,716` bytes |
| Local bytecode comparison | exact match |

## Storage run

| Field | Value |
| --- | --- |
| Run ID | `coston2-1785756146860-80659` |
| Blob ID | `ba2be5ea7080cc08ac587023e917e3f6cc80d1ebcd8a4d3e0f1cad5aaa7a7ee4` |
| Input size | `2,097,152` bytes |
| Blob commitment | `aca59e156d14cc93c43c95d64116e36301419eb8de8b4dc4ad22e58b0e421270` |
| Status after upload | `active` |
| Status after rebuild | `rebuilt` |
| Failed providers | `provider-2`, `provider-4` |
| Missing shards | `1`, `3` |
| Input SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Recovered SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Final SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |

The durable coordinator cursor ended at `33577995`. Its recovery job for this blob reached `succeeded` with one attempt and survived the complete request lifecycle. The operational state was written atomically to the ignored run directory.

The input, recovered bytes, and final read matched exactly. The run preserved the removed shard files with a `.lost` suffix before rebuilding them.

## Provider operators

| Provider | Operator | Run endpoint |
| --- | --- | --- |
| `provider-1` | `0xe9D942623369279B69f34e527c54E01ae0f94965` | `http://127.0.0.1:7560` |
| `provider-2` | `0xA439f317939A49c0ACf1020E5f2182602a35b76a` | `http://127.0.0.1:7561` |
| `provider-3` | `0xCd647cd81c75D1Ad1524daB03a739629ED1F3223` | `http://127.0.0.1:7562` |
| `provider-4` | `0x12dE344C457b8e8eD7c21c41D52b38a5ED971748` | `http://127.0.0.1:7563` |

## Event evidence

The Coston2 event indexer read 22 events from block `33577930` through the run tip. The cursor was persisted by the operational store.

| Event | Count |
| --- | ---: |
| `ProviderRegistered` | 4 |
| `BlobCreated` | 1 |
| `ShardAssigned` | 6 |
| `ShardAcknowledged` | 6 |
| `BlobFinalized` | 1 |
| `RecoveryStarted` | 2 |
| `ShardRebuilt` | 2 |

## Key transactions

Provider registration transactions:

```text
provider-1  0xf91342f75f56e31b232fae9ef70bdd767b2defbec2e601bea75a1aed3685af94
provider-2  0xf69d99743ef6dd282cbe1b91728c099ffa7067f9a08b43a5d12626eb2656ce2f
provider-3  0xe4cd5d26f281979aec19337de2bcdc0b6f6bfcc635ac6e0eb297f8349e2ba636
provider-4  0x6ed2a55a307025ea5a9515a8dfb76b430831b453bed1c50500c6ecf62a9c8907
```

Blob creation and finalization:

```text
createBlob    0x8e3eec0aefccc557aca904bebee7d78d333d0ee856faf453e5f1c93805ca9d9c
finalizeBlob  0x6f4129c972094c10ae861edb5f32fd9823a07d06745c7bf620c7d7ae08473abc
```

Recovery and rebuild transactions:

```text
startRecovery       0x7ec12c554d492d685ef23f62521c5f72573570d18808fcd1858c5ba45510e7f8
reassignShard       0xbb4cda9ed99eedaf657b85beb5db36f234b1e2cec078a4cc8142953cf8b7cea9
acknowledgeShard    0x45eac56168c74a4c036915793c0c5d77245c351e1cdf3038b0b55dc9237127a7
recordRebuiltShard  0x9d85c7423a73421bde0a9ca459e8cf58840bd547c931e750648794b2ffe96e4c
startRecovery       0x59f2c7c860075882f91e145ba712ba2a632e031bc6266e0a1c4641c4ef758710
reassignShard       0xe9cdfb03ac84c28767686a8f68073632b31cfd8cca04fabcb69d3f68e09eb272
acknowledgeShard    0x2d4e4a160036d6a68f488fc8aea84c8493e5f084a149f40bb468e8fdc2564317
recordRebuiltShard  0x919a6dcc1b4cdcfc81ef6f82f2b353e6b5063ba6b4ae6adc3b42cd239a17a9ee
```

The complete machine-readable record, including all assignment and acknowledgement transactions plus the persisted operational state, lives at `.prime-server/evidence/coston2/coston2-1785756146860-80659.json` and remains ignored by Git because it contains local paths.
