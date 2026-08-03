# Coston2 FCC sender deployment

Status: the Prime Server FCC transport and attestation-verifier contracts are deployed on Coston2. The official extension code is prepared and builds against Flare's TypeScript scaffold. The live key-rewrap proof remains gated on Flare's private Coston2 indexer credentials, which the official scaffold requires for `ext-proxy`.

## Frozen storage boundary

- Chain ID: `114`
- PrimeServerRegistry: `0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1`
- Registry deployment transaction: `0x46eb564d952657759a1f8106462128fdd84d095c8d86709f2652ceb95a44566e`
- No registry deployment or bytecode write was made for this slice. Current runtime bytecode remains `24,355` bytes, matching the frozen deployment evidence.
- The only registry state change for this slice is the explicit authorization of the FCC sender as `confidentialAccessController`.

## Deployed contracts

| Component | Address | Deployment transaction |
| --- | --- | --- |
| PrimeServerFccResultVerifier | `0xdA5C56F28d0834b1084E98074aa1F3432f294e0E` | `0x29eff1a85064a7cae92123b33ff418fe194701312af0c391d54ba83859b3978d` |
| PrimeServerInstructionSender | `0x84B117F9a8262a3a7003da843d53e9cbFE756232` | `0x80ea44487df572c1f60e3efe18cb924ff183780e8b9d44c5e2949378c03f7a1f` |

The sender constructor points to the frozen registry and Flare's Coston2 `FlareTeeManager` at `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`. The verifier is the sender's result submitter. The sender was granted controller permission by transaction `0xa4f37bf2155cd36451251e96de245a42849b6079472a8c29a88601714dfb4751`.

## Extension wiring

- Public extension ID selected for the sender: `65922`
- Sender `setExtensionId` transaction: `0x75956baefd5e87027b9e3f821376c9a055ca710dc11d2d0f644210eb19006d32`
- Verifier sender configuration transaction: `0x31d2c6136a1e81fbb237991311a9c90639feddfd70d8d58a55d5fadde522f511`
- Onchain read confirms extension `65922` resolves to the sender address.

Two public extension IDs were created during registration setup, `65922` and `65923`. The sender is permanently configured to `65922`. No third registration is required.

## Result boundary

`PrimeServerFccResultVerifier` accepts a result only when all of these checks pass:

- the instruction ID is bound to the Prime Server access request;
- the result status is successful;
- the configured machine is still registered for the configured extension;
- the official `TEE_ACTION_RESULT` domain hash recovers the registered TEE machine address;
- the response commitment is computed from the exact result data before the sender relays it to the frozen registry.

The local Foundry verifier tests cover the official domain hash, EIP-191 signature recovery, response commitment relay, and instruction replay rejection. The live proof runner is `scripts/coston2-fcc-key-rewrap-demo.mjs`.

## Remaining live gate

The official Coston2 flow still needs:

1. Flare indexer read-only credentials in the scaffold's Coston2 proxy TOML.
2. The official extension proxy and TypeScript TEE container running behind an HTTPS tunnel.
3. `post-build.sh` to approve the code version, register governance, and register the simulated TEE machine.
4. Verifier configuration with that machine ID.
5. The live second-device proof, where the source file key is zeroed before registration and the second device decrypts only with the FCC-returned package.

This slice is deliberately described as deployed transport plus prepared simulated-TEE integration until those live steps produce a signed Coston2 result. The official workflow and credential requirement are documented in the [Flare FCC extension guide](https://dev.flare.network/fcc/guides/getting-started).
