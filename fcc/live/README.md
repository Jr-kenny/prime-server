# Prime Server official FCC extension

This directory contains the small TypeScript application copied into Flare's
official `fce-extension-scaffold` for the Coston2 simulated-TEE deployment.
The scaffold still supplies the TEE node, extension proxy, registration tools,
and container lifecycle.

The live envelope uses the ECIES profile implemented by `tee-node`, so the
extension asks the TEE node's local `/decrypt` endpoint to open the sealed
file-key payload. The extension never receives a raw TEE private key. It
returns either a device-wrapped file-key package or a signed confidential
compute result as `ActionResult.Data`.

The `COMPUTE` route retrieves ciphertext through the authenticated Prime Server
internal path configured by `PRIME_SERVER_FCC_STORAGE_URL` and
`PRIME_SERVER_FCC_INTERNAL_TOKEN`. It decrypts and analyzes the payload inside
the extension process, then returns only the approved operation result and its
response commitment. Plaintext never enters the instruction payload or the
public RPC route.

The Prime RPC process must expose the same internal token and pass
`PRIME_SERVER_FCC_PROXY_URL` to the public FCC result proxy. The UI calls the
authenticated `/prime/v1/fcc/info` and `/prime/v1/fcc/result/:instructionId`
routes, so the FCC proxy URL and token stay server-side.

For Docker Compose, pass `PRIME_SERVER_FCC_STORAGE_URL` and
`PRIME_SERVER_FCC_INTERNAL_TOKEN` into the `extension-tee` container. The
storage URL must be reachable from that container. `127.0.0.1` points back to
the container itself and will not reach a Prime RPC process running on the
host.
