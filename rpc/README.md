# Prime RPC

This directory will contain the client-facing upload, download, range-read, placement, and recovery API.

The RPC coordinates provider work, but Flare contract state and successful content verification remain the evidence boundary.

The first local integration uses `MemoryRegistry` as an explicit test adapter. It verifies provider signatures and protocol rules without presenting local state as an onchain result. The Coston2 registry adapter belongs to Slice 7.
