# Prime Server FCC extension

This package is the local FCC extension core for Prime Server. It implements the two operation families sent by `PrimeServerInstructionSender`:

- `PRIME_SERVER / KEY_REWRAP`, which opens an FCC-sealed file-key envelope inside the extension and returns a key package encrypted to the requesting device public key.
- `PRIME_SERVER / COMPUTE`, which retrieves ciphertext through an injected internal retrieval function, decrypts inside the handler, runs an approved operation, and returns only the result and its response commitment.

The Solidity sender uses the current Flare FCC instruction shape, including `TeeInstructionParams`, extension ID discovery, random TEE selection, and `sendInstructions`. The payloads are ABI encoded so the production FCE scaffold can decode them in its TypeScript handler.

The local package proves cryptographic behavior and wire compatibility. The `live/` package is prepared for the official Flare FCE TypeScript scaffold and Coston2 simulated-TEE flow. It does not claim a live key release until public extension registration, TEE version approval, machine registration, and a signed Coston2 result have completed.

`src/fce-adapter.mjs` registers the handlers with the official FCE TypeScript framework shape. The adapter injects the TEE private key and the secure ciphertext retrieval function at runtime, so those values never become public application configuration.

The sender must be granted `confidentialAccessController` permission on the frozen `PrimeServerRegistry` before `recordAccessResult` can be used. The deployed verifier is the sender's result submitter and checks the official TEE result signature against the registered machine before relaying a response commitment.

The current Flare extension pattern is documented in the [official FCC extension guide](https://dev.flare.network/fcc/guides/getting-started) and the [official private-key extension guide](https://dev.flare.network/fcc/guides/sign-extension).
