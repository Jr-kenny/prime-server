// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrimeServerRegistry} from "../src/PrimeServerRegistry.sol";

contract PrimeServerActor {
    function register(
        PrimeServerRegistry registry,
        string calldata endpoint,
        bytes32 signingKey
    ) external returns (uint256) {
        return registry.registerProvider(endpoint, signingKey);
    }

    function setStatus(PrimeServerRegistry registry, uint256 providerId, bool active) external {
        registry.setProviderStatus(providerId, active);
    }

    function acknowledge(
        PrimeServerRegistry registry,
        bytes32 blobId,
        uint8 shardIndex,
        bytes32 shardCommitment,
        uint64 shardSize
    ) external {
        registry.acknowledgeShard(blobId, shardIndex, shardCommitment, shardSize);
    }

    function createNamed(
        PrimeServerRegistry registry,
        bytes32 blobId,
        string calldata blobName,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external {
        registry.createBlobNamed(blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt);
    }
}

contract PrimeServerRegistryTest {
    PrimeServerRegistry internal registry;

    function setUp() public {
        registry = new PrimeServerRegistry();
    }

    function testProviderRegistrationAndStatus() public {
        PrimeServerActor provider = new PrimeServerActor();
        uint256 providerId = provider.register(registry, "http://127.0.0.1:7101", bytes32(uint256(1)));

        require(providerId == 1, "first provider id should be one");
        require(registry.providerIdByOperator(address(provider)) == 1, "operator mapping missing");

        (address operator, string memory endpoint, bytes32 signingKey, bool active,) = registry.providers(providerId);
        require(operator == address(provider), "operator mismatch");
        require(bytes(endpoint).length > 0, "endpoint missing");
        require(signingKey == bytes32(uint256(1)), "signing key mismatch");
        require(active, "provider should start active");

        provider.setStatus(registry, providerId, false);
        (,,, active,) = registry.providers(providerId);
        require(!active, "provider should be inactive");
    }

    function testBlobPlacementAcknowledgementAndFinalization() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        bytes32 blobId = keccak256("blob-1");

        registry.createBlob(blobId, keccak256("root-1"), 2048, 1024, 2, 4);
        registry.assignShard(blobId, 0, registry.providerIdByOperator(address(p1)));
        registry.assignShard(blobId, 1, registry.providerIdByOperator(address(p2)));
        registry.assignShard(blobId, 2, registry.providerIdByOperator(address(p3)));
        registry.assignShard(blobId, 3, registry.providerIdByOperator(address(p4)));

        p1.acknowledge(registry, blobId, 0, bytes32(uint256(100)), 1024);
        p2.acknowledge(registry, blobId, 1, bytes32(uint256(101)), 1024);
        p3.acknowledge(registry, blobId, 2, bytes32(uint256(102)), 1024);
        p4.acknowledge(registry, blobId, 3, bytes32(uint256(103)), 1024);

        registry.finalizeBlob(blobId);

        (,,,,,, uint256 acknowledgementCount, PrimeServerRegistry.BlobStatus status, bool exists, uint64 expiresAt) = registry.blobs(blobId);
        require(acknowledgementCount == 4, "acknowledgement count mismatch");
        require(status == PrimeServerRegistry.BlobStatus.Active, "blob should be active");
        require(exists, "blob should exist");
        require(expiresAt == 0, "legacy blob should not expire");
    }

    function testFinalizeRejectsMissingAcknowledgement() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        bytes32 blobId = keccak256("blob-2");

        registry.createBlob(blobId, keccak256("root-2"), 2048, 1024, 2, 4);
        registry.assignShard(blobId, 0, registry.providerIdByOperator(address(p1)));
        registry.assignShard(blobId, 1, registry.providerIdByOperator(address(p2)));
        registry.assignShard(blobId, 2, registry.providerIdByOperator(address(p3)));
        registry.assignShard(blobId, 3, registry.providerIdByOperator(address(p4)));

        p1.acknowledge(registry, blobId, 0, bytes32(uint256(200)), 1024);
        p2.acknowledge(registry, blobId, 1, bytes32(uint256(201)), 1024);
        p3.acknowledge(registry, blobId, 2, bytes32(uint256(202)), 1024);

        (bool success,) = address(registry).call(
            abi.encodeWithSelector(registry.finalizeBlob.selector, blobId)
        );
        require(!success, "finalization should require every shard acknowledgement");
    }

    function testRecoveryCanReassignAndRecordRebuild() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        bytes32 blobId = keccak256("blob-3");

        registry.createBlob(blobId, keccak256("root-3"), 2048, 1024, 2, 4);
        registry.assignShard(blobId, 0, registry.providerIdByOperator(address(p1)));
        registry.assignShard(blobId, 1, registry.providerIdByOperator(address(p2)));
        registry.assignShard(blobId, 2, registry.providerIdByOperator(address(p3)));
        registry.assignShard(blobId, 3, registry.providerIdByOperator(address(p4)));
        p1.acknowledge(registry, blobId, 0, bytes32(uint256(300)), 1024);
        p2.acknowledge(registry, blobId, 1, bytes32(uint256(301)), 1024);
        p3.acknowledge(registry, blobId, 2, bytes32(uint256(302)), 1024);
        p4.acknowledge(registry, blobId, 3, bytes32(uint256(303)), 1024);
        registry.finalizeBlob(blobId);

        registry.startRecovery(blobId, 1);
        PrimeServerActor replacement = new PrimeServerActor();
        uint256 replacementId = replacement.register(registry, "http://127.0.0.1:7201", bytes32(uint256(5)));
        registry.reassignShard(blobId, 1, replacementId);
        registry.recordRebuiltShard(blobId, 1, replacementId, bytes32(uint256(401)));

        require(registry.placement(blobId, 1) == replacementId, "placement was not reassigned");
        (,,,,,, , PrimeServerRegistry.BlobStatus status,,) = registry.blobs(blobId);
        require(status == PrimeServerRegistry.BlobStatus.Rebuilt, "blob should be rebuilt");
    }

    function testCoordinatorCanCreateUserOwnedExpiringBlob() public {
        PrimeServerActor user = new PrimeServerActor();
        uint64 expiresAt = uint64(block.timestamp + 86_400);
        bytes32 blobId = keccak256("user-owned-blob");
        string memory blobName = "app/config.json";

        registry.createBlobForNamed(address(user), blobId, blobName, keccak256("user-root"), 1024, 1024, 2, 4, expiresAt);

        (address owner,,,,,,, , bool exists, uint64 storedExpiry) = registry.blobs(blobId);
        require(owner == address(user), "blob owner should be the user wallet");
        require(exists, "user blob should exist");
        require(storedExpiry == expiresAt, "blob expiry mismatch");
        bytes32 nameHash = keccak256(bytes(blobName));
        require(registry.blobNameHashes(blobId) == nameHash, "blob name hash mismatch");
        require(keccak256(bytes(registry.blobNames(blobId))) == nameHash, "blob name mismatch");
        require(registry.blobIdByOwnerNameHash(address(user), nameHash) == blobId, "owner name index mismatch");

        _assertDuplicateNameRejected(user, blobName, expiresAt);
    }

    function testWalletCanCreateNamedBlob() public {
        PrimeServerActor user = new PrimeServerActor();
        bytes32 blobId = keccak256("direct-user-owned-blob");
        string memory blobName = "wallet/owned.txt";
        uint64 expiresAt = uint64(block.timestamp + 86_400);

        user.createNamed(registry, blobId, blobName, keccak256("direct-user-root"), 1024, 1024, 2, 4, expiresAt);

        (address owner,,,,,,, , bool exists, uint64 storedExpiry) = registry.blobs(blobId);
        require(owner == address(user), "direct blob owner should be the signing wallet");
        require(exists, "direct blob should exist");
        require(storedExpiry == expiresAt, "direct blob expiry mismatch");
        require(keccak256(bytes(registry.blobNames(blobId))) == keccak256(bytes(blobName)), "direct blob name mismatch");
    }

    function _assertDuplicateNameRejected(
        PrimeServerActor user,
        string memory blobName,
        uint64 expiresAt
    ) internal {
        bool reverted;
        try registry.createBlobForNamed(
            address(user),
            keccak256("duplicate-name"),
            blobName,
            keccak256("duplicate-root"),
            1024,
            1024,
            2,
            4,
            expiresAt
        ) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "owner blob names should be unique");
    }

    function _registerFour()
        internal
        returns (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4)
    {
        p1 = new PrimeServerActor();
        p2 = new PrimeServerActor();
        p3 = new PrimeServerActor();
        p4 = new PrimeServerActor();
        p1.register(registry, "http://127.0.0.1:7101", bytes32(uint256(1)));
        p2.register(registry, "http://127.0.0.1:7102", bytes32(uint256(2)));
        p3.register(registry, "http://127.0.0.1:7103", bytes32(uint256(3)));
        p4.register(registry, "http://127.0.0.1:7104", bytes32(uint256(4)));
    }
}
