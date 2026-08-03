# Provider daemon

This directory will contain the isolated Prime Server storage provider process.

Each provider must run with its own operator identity, endpoint, and data directory. The first implementation will expose shard upload, shard download, range reads, health, and signed acknowledgements.

