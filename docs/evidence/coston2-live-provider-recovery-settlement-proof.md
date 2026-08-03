# Prime Server Coston2 live provider, recovery, and settlement proof

Status: passed against the frozen settlement-corrected registry.

Registry:

- Address: `0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1`
- Chain ID: `114`
- Deployment block: `33590506`
- Deployment transaction: `0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e`
- Runtime bytecode: `24,355` bytes

The proof uses four local provider processes with four funded Coston2 operator wallets. The provider bytes, acknowledgements, recovery writes, paid registration, provider claims, and final payment state are live network observations. The machine-readable run records remain under `.prime-server/evidence/coston2/`.

## Provider failure and recovery

Command:

```bash
node scripts/coston2-demo.mjs
```

Run: `coston2-1785785829219-56293`

- Blob ID: `7fb9167be9d886831b4f8532527d5d0a70eea2929e26538f284b83027362f9f1`
- Input size: `2,097,152` bytes
- Input SHA-256: `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f`
- Failed providers: `provider-2`, `provider-4`
- Missing shards: `1`, `3`
- Status after upload: `active`
- Status after rebuild: `rebuilt`
- Recovered SHA-256: `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f`
- Final SHA-256: `70a5aa60279a696319d492e948cc9ba794da0e9174b81ad1d702554502f4801f`
- Final bytes match input: `true`

The run stopped providers 2 and 4, reconstructed the object from the two surviving shards, rebuilt both missing shards, and recorded the recovery lifecycle on Flare. The key recovery transactions were:

- `startRecovery` block `33590834`, transaction `0xdfd91ad5c4260a176065908d7607f2be7e5e8d02ee814bc6ba42995adc560f73`
- `reassignShard` block `33590835`, transaction `0xef1bd3c9e2112cf7ae2579257184bbaf33b5c606468635b4cda016724c5b7f12`
- `recordRebuiltShard` block `33590843`, transaction `0x7899de78b8476c0f5e4e5b330a3afbda437fc01504cec544a9544e25211c43f3`
- `recordRebuiltShard` block `33590849`, transaction `0x28c30512ac9556728db8bc46d3eb35cb23fd2ef9099e140bde8e354628467db5`

## Paid settlement reassignment

Command:

```bash
node scripts/coston2-settlement-reassignment-demo.mjs
```

Run: `coston2-settlement-1785786797441-58600`

- Blob ID: `0x32abcda5929a4b7fd914267b48fc613afe88b947e4c3a748a2bea8b3c05bbc09`
- Input size: `262,144` bytes
- Input SHA-256: `f39fcc5519bd2ecfee81dd67798b15e28eb01c72e4fa998463a25e306a7f2dae`
- Original provider: `provider-1`
- Replacement provider: `provider-2`
- Reassigned shard: `0`
- Recovered SHA-256: `f39fcc5519bd2ecfee81dd67798b15e28eb01c72e4fa998463a25e306a7f2dae`
- Final blob status: `rebuilt`

Payment sequence:

- Total paid: `4,200,000,000,000` wei
- Provider pool: `4,000,000,000,000` wei
- Immediate reward per shard: `900,000,000,000` wei
- Reserve per shard: `100,000,000,000` wei
- Immediate settlement after upload: `3,600,000,000,000` wei
- Replacement provider claim for reassigned shard: `100,000,000,000` wei
- Final provider settlement: `4,000,000,000,000` wei
- Final payment status: `settled`
- Global immediate marker: `true`
- Global reserve marker: `true`

The original provider received the shard's immediate reward before failure. After reassignment, provider 2 received exactly one reserve for shard 0. The payment reached the full provider pool without a second immediate reward.

Key transactions:

- Paid registration: `0xe40930b4297d889bfec735b0c5ac46a2d7ec9c67f6c773261bda93dcb77bb457`
- `startRecovery`: block `33591273`, transaction `0x2a919aa7e7207be29644640f93522ed4f8ea61c7ad329a60b1cefc50ce96e66c`
- `reassignShard`: block `33591274`, transaction `0x2d09d731e01c7485faafdf655882d4547e522b87d65121ca47e98dfefa391fd8`
- Replacement `acknowledgeShard`: block `33591280`, transaction `0xb3a923d045f30620e7e505534c286447d7ca65c241cefd6de148820eb1b3f21a`
- `recordRebuiltShard`: block `33591281`, transaction `0x4d09080b3d7ccd78d5f2ccdd9652000cc9bce0b9db1bc2b828c1362e09eae426`
- Replacement reserve claim: block `33591367`, transaction `0x2a17cc6a5d969ef51728e7a745ebde5a80ffaffcd4e63d62d89f461762eee2a0`
- Final provider claim: block `33591372`, transaction `0xcd590d742eb950fb783a3fdd212abc0c51391851d5ed982a9141e46693451c04`

This proves the global per-shard settlement marker behavior on Coston2. The public native paid path, provider failure, reconstruction, reassignment, rebuilt acknowledgement, expiry reserve, and full settlement all passed live.

The proof does not claim live FCC attestation or confidential key release. XRP, FDC, and FAssets settlement remain separate pending layers.
