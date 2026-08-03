# Prime RPC

This package contains the Prime Server coordinator and the wallet-owned developer gateway at `/prime/v1`.

The gateway supports wallet-signature sessions, registration-first named blobs, upload, list, metadata, full downloads, range reads, and browser CORS. The JavaScript client lives in `../sdk`.

Multipart uploads, an S3-compatible gateway, and payment sessions remain explicit follow-up slices.

The RPC coordinates provider work, but Flare contract state and successful content verification remain the evidence boundary.

The first local integration uses `MemoryRegistry` as an explicit test adapter. It verifies provider signatures and registration rules without presenting local state as an onchain result. The Coston2 registry adapter is used by the production node after the registration-first registry contract is deployed.
