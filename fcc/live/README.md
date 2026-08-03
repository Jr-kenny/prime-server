# Prime Server official FCC extension

This directory contains the small TypeScript application copied into Flare's
official `fce-extension-scaffold` for the Coston2 simulated-TEE deployment.
The scaffold still supplies the TEE node, extension proxy, registration tools,
and container lifecycle.

The live envelope uses the ECIES profile implemented by `tee-node`, so the
extension asks the TEE node's local `/decrypt` endpoint to open the sealed
file-key payload. The extension never receives a raw TEE private key. It
returns only a device-wrapped file-key package as the signed `ActionResult.Data`.
