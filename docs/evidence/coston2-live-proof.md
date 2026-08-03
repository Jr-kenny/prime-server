# Prime Server Coston2 core live proof

Recorded on 2026-08-03 from the local Prime Server checkout.

These results come from two runs against the earlier registry below. The first run proves provider placement, shard loss, recovery, and rebuild. The second run proves the public registration-first wallet flow through the SDK and developer API. The current registry with native payment, policy, and access-intent fields is documented in [coston2-paid-live-proof.md](./coston2-paid-live-proof.md).

The provider endpoints in these runs use loopback addresses on the Mac. They prove process isolation and the protocol lifecycle. They are not public storage endpoints.

## Deployment

| Field | Value |
| --- | --- |
| Chain ID | `114` |
| Registry | `0x5D80eb0675b4786D275bb5e2D8EE0172fBCd6444` |
| Deployment block | `33582324` |
| Deployment transaction | `0x999bea3a01ea4bad37ab62c244329d3db588d05bea352d3b1bef67afee746b84` |
| Compiler | Solidity `0.8.24` |
| Deployed runtime bytecode | `10,849` bytes |
| Deployment receipt | success |

The deployment in this document is historical. The ignored local `.env` now points Prime RPC and the proof harness at the replacement registry documented in [coston2-paid-live-proof.md](./coston2-paid-live-proof.md).

## Four-provider recovery proof

| Field | Value |
| --- | --- |
| Run ID | `coston2-1785765872799-9253` |
| Blob ID | `47dd5821d3bf0d6d1b6dca39245dc08132d7dbbca031e77c894b0fa9e5a000c2` |
| Input size | `2,097,152` bytes |
| Blob commitment | `aca59e156d14cc93c43c95d64116e36301419eb8de8b4dc4ad22e58b0e421270` |
| Status after upload | `active` |
| Status after rebuild | `rebuilt` |
| Failed providers | `provider-2`, `provider-4` |
| Missing shards | `1`, `3` |
| Input SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Recovered SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Final SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |

The input, recovered bytes, and final read matched exactly. The run preserved the removed shard files with a `.lost` suffix before rebuilding them. The durable operational cursor ended at block `33582404`, and the recovery job reached `succeeded` after one attempt.

### Provider operators

| Provider | Operator | Run endpoint |
| --- | --- | --- |
| `provider-1` | `0xe9D942623369279B69f34e527c54E01ae0f94965` | `http://127.0.0.1:7354` |
| `provider-2` | `0xA439f317939A49c0ACf1020E5f2182602a35b76a` | `http://127.0.0.1:7355` |
| `provider-3` | `0xCd647cd81c75D1Ad1524daB03a739629ED1F3223` | `http://127.0.0.1:7356` |
| `provider-4` | `0x12dE344C457b8e8eD7c21c41D52b38a5ED971748` | `http://127.0.0.1:7357` |

### Event evidence

The event indexer read the following events from block `33582343` through the run tip and persisted its cursor:

| Event | Count |
| --- | ---: |
| `ProviderRegistered` | 4 |
| `BlobCreated` | 1 |
| `ShardAssigned` | 6 |
| `ShardAcknowledged` | 6 |
| `BlobFinalized` | 1 |
| `RecoveryStarted` | 2 |
| `ShardRebuilt` | 2 |

### Recovery transactions

```text
createOperatorBlob  0x32790baed2eebb6c0ec57b89befbd6cfded09b9ea9916c269f7304cfea47b507
finalizeBlob        0xd17c64056846006b8eadadcdb138e9d6bb3680ac27e77faa1f970bc0c9725726
startRecovery       0x0bd413c876f4df7d38795044d15febde59fb7be75b12a7aa5274ca0a3db72fb3
reassignShard       0xa41c58fb2fd5c98b06fd356c96a86a93486e78a2d4fccd7cfb7e24f3085825cd
acknowledgeShard    0x3db2c0f176adecdf4b0f79c0e622e01e4ddfe1e075d2be84fb289407fe436643
recordRebuiltShard  0xa93616d7915fe750a22fcc72000f3f62563032797ed54dee491b34621fd6086d
startRecovery       0x0a82d3afc899cf21bbaf2d994ffa261ff250fd90e2e5513f95cb531f18607916
reassignShard       0xb98948b881861feec012211d6556bbe68603b213c2234ba77f10bd699b804d3b
acknowledgeShard    0xab272282f2741e8ed2aadee2fb97c27fcbf83624960634d0a9486c4cbba39627
recordRebuiltShard  0x860075f6b810399125cf5a46f9e4c6645b9fcfe6586e706de94724469a281015
```

## Direct-wallet developer API proof

This run uses `scripts/coston2-registered-demo.mjs`. It generates a temporary wallet that is different from the deployer, funds it on Coston2, computes the Clay commitment locally, calls `createBlobNamed` from that wallet, waits for the successful receipt through `@prime-server/sdk`, and then uploads the original bytes through `/prime/v1`.

| Field | Value |
| --- | --- |
| Run ID | `coston2-registered-1785766127070-9946` |
| User wallet | `0x40287B88cD7B4887206002f6ebBC6969e0c0928f` |
| Blob ID | `0x22364ae45b2d4f6c3d882b22501b8ff370b0fe139b85d4720793a4a08a5dd4f1` |
| Blob name | `live/direct-wallet-coston2-registered-1785766127070-9946.bin` |
| Input size | `262,144` bytes |
| Registration transaction | `0xe5cb9503f6b79472fc3ce660ca60e46490a3509fd244695d2709b31f45bb2ffd` |
| Registration block | `33582497` |
| Registration receipt | success |
| Owner read from Flare | same user wallet |
| Origin read from Flare | `user` |
| Status before upload | `pending` |
| Status after upload | `active` |
| Acknowledgements | `4` |
| Input SHA-256 | `76adfd3e3d37b0f3bcae509fd2afbcd668a291b8ab755703c08933235078241d` |
| Downloaded SHA-256 | `76adfd3e3d37b0f3bcae509fd2afbcd668a291b8ab755703c08933235078241d` |
| Range response | `206`, bytes `0-1023` |

The direct registration was confirmed before the SDK sent the upload request. The downloaded object matched the input byte-for-byte, and the range response matched the first 1,024 bytes.

## Machine-readable records

The complete recovery record is `.prime-server/evidence/coston2/coston2-1785765872799-9253.json`.

The complete direct-wallet record is `.prime-server/evidence/coston2/coston2-registered-1785766127070-9946.json`.

These files remain ignored by Git because they contain local provider paths and temporary runtime details.

## Replacement registry regression proof

The proven storage and recovery core was rerun against the replacement registry on 2026-08-03 after the payment and access schema changes.

| Field | Value |
| --- | --- |
| Run ID | `coston2-1785771713115-23093` |
| Registry | `0x73f92b133e6259f170Bc42FA708F476CDE15AdD0` |
| Blob ID | `598e147e2df6b215409e2611be045345b3df623a9572f9d2785df076fa5f873e` |
| Failed providers | `provider-2`, `provider-4` |
| Missing shards | `1`, `3` |
| Input SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Recovered SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Final SHA-256 | `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f` |
| Final status | `rebuilt` |

The replacement run recorded one `BlobCreated`, six shard assignments, six shard acknowledgements, one finalization, two recovery starts, and two rebuilt-shard events. Its machine-readable record is `.prime-server/evidence/coston2/coston2-1785771713115-23093.json`.
