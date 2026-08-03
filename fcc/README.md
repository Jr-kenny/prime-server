# Prime Server FCC extension

This package is the local FCC extension core for Prime Server. It implements the two operation families sent by `PrimeServerInstructionSender`:

- `PRIME_SERVER / KEY_REWRAP`, which opens an FCC-sealed file-key envelope inside the extension and returns a key package encrypted to the requesting device public key.
- `PRIME_SERVER / COMPUTE`, which retrieves ciphertext through an injected internal retrieval function, decrypts inside the handler, runs an approved operation, and returns only the result and its response commitment.

The Solidity sender uses the current Flare FCC instruction shape, including `TeeInstructionParams`, extension ID discovery, random TEE selection, and `sendInstructions`. The payloads are ABI encoded so the production FCE scaffold can decode them in its TypeScript handler.

The local package proves cryptographic behavior and wire compatibility. It does not claim a live FCC extension, registered TEE machine, code-hash approval, attestation, or production proxy. Those require the Flare FCE deployment flow, public extension registration, TEE version approval, machine registration, and a live Coston2 result.

`src/fce-adapter.mjs` registers the handlers with the official FCE TypeScript framework shape. The adapter injects the TEE private key and the secure ciphertext retrieval function at runtime, so those values never become public application configuration.

The sender must be granted `confidentialAccessController` permission on the frozen `PrimeServerRegistry` before `recordAccessResult` can be used. The configured result submitter is an explicit relay boundary until FCC result attestation verification is integrated.

The current Flare extension pattern is documented in the [official FCC extension guide](https://dev.flare.network/fcc/guides/getting-started) and the [official private-key extension guide](https://dev.flare.network/fcc/guides/sign-extension).
