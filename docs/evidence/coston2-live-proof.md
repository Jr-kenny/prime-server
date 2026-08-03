# Prime Server Coston2 live proof

Recorded on 2026-08-03 from the local Prime Server checkout.

This is a real four-process storage proof on Flare Coston2. The provider endpoints in this run use loopback addresses on the Mac. They prove process isolation and the protocol lifecycle. They are not public storage endpoints.

## Deployment

| Field | Value |
| --- | --- |
| Chain ID | `114` |
| Registry | `0x0cF2205c21BdF773Bb104aA03f553F122416B7ac` |
| Deployment block | `33577496` |
| Deployment transaction | `0xe46308a2a745e822ec36108e1abc6964ae8ba7332a5272c575d585c3632bf59d` |
| Compiler | Solidity `0.8.24` |
| Deployed bytecode | `7,716` bytes |
| Local bytecode comparison | exact match |

## Storage run

| Field | Value |
| --- | --- |
| Run ID | `coston2-1785755331585-77466` |
| Blob ID | `51e2662ed8e12a986160fb2bc53e4546a0cb3138c9af498040a71ce19a9adb6b` |
| Input size | `2,097,152` bytes |
| Blob commitment | `aca59e156d14cc93c43c95d64116e36301419eb8de8b4dc4ad22e58b0e421270` |
| Status after upload | `active` |
| Status after rebuild | `rebuilt` |
| Failed providers | `provider-2`, `provider-4` |
| Missing shards | `1`, `3` |
| Input SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Recovered SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Final SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |

The input, recovered bytes, and final read matched exactly. The run preserved the removed shard files with a `.lost` suffix before rebuilding them.

## Provider operators

| Provider | Operator | Run endpoint |
| --- | --- | --- |
| `provider-1` | `0xe9D942623369279B69f34e527c54E01ae0f94965` | `http://127.0.0.1:7567` |
| `provider-2` | `0xA439f317939A49c0ACf1020E5f2182602a35b76a` | `http://127.0.0.1:7568` |
| `provider-3` | `0xCd647cd81c75D1Ad1524daB03a739629ED1F3223` | `http://127.0.0.1:7569` |
| `provider-4` | `0x12dE344C457b8e8eD7c21c41D52b38a5ED971748` | `http://127.0.0.1:7570` |

## Event evidence

The Coston2 event indexer read 22 events from block `33577497` through the run tip.

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
provider-1  0xb1688403d240a75fd1cf1f493fa3f04cf6912740d9b0b45fb9b2d18c8581dbc1
provider-2  0xe1687d485fb96f01b77a9d4c338cbf21ababac582008d069d9d4854a86e7e904
provider-3  0x46e356fa3944465d5092164c5b695d1610cc8ca870f832a281884f778dd139da
provider-4  0xedc500518798cfbcc82431c0845f5eafa64f3077d59ca480c3f2c1917bcef41f
```

Blob creation and finalization:

```text
createBlob    0x9ffd3d39e551dfb0fb54422c55e8e6aecf9f624b9dba3cfadafb159fc97e1945
finalizeBlob  0xcbdf6bb2db514f0bf868ed95c89e54dfcd9e4285ed52c50311f29c6704ac7927
```

Recovery and rebuild transactions:

```text
startRecovery       0x5808ca9586d380ec5ec1b07052527892b3120a60aa4ece0fd9fc07a2db7f9d4d
reassignShard       0x6c2c236a25bb641f4adef51bde3796274cea04f559d44dda78fbea2ce5b69f79
acknowledgeShard    0x9f9dcfd81ad9efd5ef6c206fbf1f2d351cc8bcb8943c16269e44d22a58b3b5d4
recordRebuiltShard  0x65d4467b7e57250a111e336ab70dc6b4b449b6ea60cf9241ebd802adf71af79b
startRecovery       0x7539a36ce0f3a7df96779510ea74419a39392bc80edc29fcc0a5677e128a4190
reassignShard       0x77ca50e346f0db05285ef3685d4bfb6bcfe1638f784c125102314da42857a2f0
acknowledgeShard    0xa89ce8f51c91f3de3d2a31f011fb728917aecb438f000d209b66619b37e8d762
recordRebuiltShard  0xaea5d8c6d4d9b4fea0b83aee120a0cf3687517e95d0f44e23ea51897852ef2ef
```

The complete machine-readable record, including all assignment and acknowledgement transactions, lives at `.prime-server/evidence/coston2/coston2-1785755331585-77466.json` and remains ignored by Git because it contains local paths.
