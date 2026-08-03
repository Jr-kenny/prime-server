// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrimeServerRegistry} from "../src/PrimeServerRegistry.sol";

interface PrimeServerVm {
    function deal(address who, uint256 newBalance) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract PrimeServerActor {
    function register(PrimeServerRegistry registry, string calldata endpoint, bytes32 signingKey)
        external
        returns (uint256)
    {
        return registry.registerProvider(endpoint, signingKey);
    }

    function setStatus(PrimeServerRegistry registry, uint256 providerId, bool active) external {
        registry.setProviderStatus(providerId, active);
    }

    function createNamedPaid(
        PrimeServerRegistry registry,
        PrimeServerRegistry.PaidBlobRegistration calldata registration
    ) external payable {
        registry.createBlobNamedPaid{value: msg.value}(registration);
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

    function claimSettlement(PrimeServerRegistry registry, bytes32 blobId, uint8[] calldata shardIndices)
        external
        returns (uint256)
    {
        return registry.claimProviderSettlement(blobId, shardIndices);
    }

    receive() external payable {}

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

    function createOperatorNamed(
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
        registry.createOperatorBlobNamed(
            blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt
        );
    }
}

contract PrimeServerRegistryTest {
    PrimeServerRegistry internal registry;
    PrimeServerVm internal constant vm = PrimeServerVm(address(uint160(uint256(keccak256("hevm cheat code")))));

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

        registry.createOperatorBlob(blobId, keccak256("root-1"), 2048, 1024, 2, 4, 0);
        registry.assignShard(blobId, 0, registry.providerIdByOperator(address(p1)));
        registry.assignShard(blobId, 1, registry.providerIdByOperator(address(p2)));
        registry.assignShard(blobId, 2, registry.providerIdByOperator(address(p3)));
        registry.assignShard(blobId, 3, registry.providerIdByOperator(address(p4)));

        p1.acknowledge(registry, blobId, 0, bytes32(uint256(100)), 1024);
        p2.acknowledge(registry, blobId, 1, bytes32(uint256(101)), 1024);
        p3.acknowledge(registry, blobId, 2, bytes32(uint256(102)), 1024);
        p4.acknowledge(registry, blobId, 3, bytes32(uint256(103)), 1024);

        registry.finalizeBlob(blobId);

        (,,,,,, uint256 acknowledgementCount, PrimeServerRegistry.BlobStatus status, bool exists, uint64 expiresAt,) =
            registry.blobs(blobId);
        require(acknowledgementCount == 4, "acknowledgement count mismatch");
        require(status == PrimeServerRegistry.BlobStatus.Active, "blob should be active");
        require(exists, "blob should exist");
        require(expiresAt == 0, "legacy blob should not expire");
    }

    function testFinalizeRejectsMissingAcknowledgement() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        bytes32 blobId = keccak256("blob-2");

        registry.createOperatorBlob(blobId, keccak256("root-2"), 2048, 1024, 2, 4, 0);
        registry.assignShard(blobId, 0, registry.providerIdByOperator(address(p1)));
        registry.assignShard(blobId, 1, registry.providerIdByOperator(address(p2)));
        registry.assignShard(blobId, 2, registry.providerIdByOperator(address(p3)));
        registry.assignShard(blobId, 3, registry.providerIdByOperator(address(p4)));

        p1.acknowledge(registry, blobId, 0, bytes32(uint256(200)), 1024);
        p2.acknowledge(registry, blobId, 1, bytes32(uint256(201)), 1024);
        p3.acknowledge(registry, blobId, 2, bytes32(uint256(202)), 1024);

        (bool success,) = address(registry).call(abi.encodeWithSelector(registry.finalizeBlob.selector, blobId));
        require(!success, "finalization should require every shard acknowledgement");
    }

    function testRecoveryCanReassignAndRecordRebuild() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        bytes32 blobId = keccak256("blob-3");

        registry.createOperatorBlob(blobId, keccak256("root-3"), 2048, 1024, 2, 4, 0);
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
        (,,,,,,, PrimeServerRegistry.BlobStatus status,,,) = registry.blobs(blobId);
        require(status == PrimeServerRegistry.BlobStatus.Rebuilt, "blob should be rebuilt");
    }

    function testCoordinatorCanCreateOnlyOperatorOwnedExpiringBlob() public {
        PrimeServerActor coordinator = new PrimeServerActor();
        registry.setCoordinator(address(coordinator), true);
        uint64 expiresAt = uint64(block.timestamp + 86_400);
        bytes32 blobId = keccak256("operator-owned-blob");
        string memory blobName = "app/config.json";

        (bool userCreationSucceeded,) = address(registry)
            .call(
                abi.encodeWithSelector(
                    registry.createBlobNamed.selector,
                    keccak256("coordinator-user-method"),
                    blobName,
                    keccak256("operator-root"),
                    1024,
                    1024,
                    2,
                    4,
                    expiresAt
                )
            );
        require(!userCreationSucceeded, "coordinators must use operator creation");

        coordinator.createOperatorNamed(
            registry, blobId, blobName, keccak256("operator-root"), 1024, 1024, 2, 4, expiresAt
        );

        (address owner,,,,,,,, bool exists, uint64 storedExpiry, PrimeServerRegistry.BlobOrigin origin) =
            registry.blobs(blobId);
        require(owner == address(coordinator), "operator blob owner should be the coordinator wallet");
        require(exists, "operator blob should exist");
        require(storedExpiry == expiresAt, "blob expiry mismatch");
        require(origin == PrimeServerRegistry.BlobOrigin.Operator, "operator origin should be recorded");
        bytes32 nameHash = keccak256(bytes(blobName));
        require(registry.blobNameHashes(blobId) == nameHash, "blob name hash mismatch");
        require(keccak256(bytes(registry.blobNames(blobId))) == nameHash, "blob name mismatch");
        require(registry.blobIdByOwnerNameHash(address(coordinator), nameHash) == blobId, "owner name index mismatch");
    }

    function testWalletCanCreateNamedBlob() public {
        PrimeServerActor user = new PrimeServerActor();
        bytes32 blobId = keccak256("direct-user-owned-blob");
        string memory blobName = "wallet/owned.txt";
        uint64 expiresAt = uint64(block.timestamp + 86_400);

        user.createNamed(registry, blobId, blobName, keccak256("direct-user-root"), 1024, 1024, 2, 4, expiresAt);

        (address owner,,,,,,,, bool exists, uint64 storedExpiry,) = registry.blobs(blobId);
        require(owner == address(user), "direct blob owner should be the signing wallet");
        require(exists, "direct blob should exist");
        require(storedExpiry == expiresAt, "direct blob expiry mismatch");
        require(keccak256(bytes(registry.blobNames(blobId))) == keccak256(bytes(blobName)), "direct blob name mismatch");
    }

    function testPaidRegistrationRecordsPolicyAndSettlesProviders() public {
        (PrimeServerActor p1, PrimeServerActor p2, PrimeServerActor p3, PrimeServerActor p4) = _registerFour();
        PrimeServerActor user = new PrimeServerActor();
        bytes32 blobId = keccak256("paid-user-owned-blob");
        bytes32 policyCommitment = keccak256("public-owner-only-policy");
        string memory blobName = "paid/hello.txt";
        uint64 expiresAt = uint64(block.timestamp + 7 days);

        (uint256 providerPool, uint256 protocolFee, uint256 providerRewardPerShard, uint256 providerReservePerShard) =
            _registerPaidBlob(registry, user, blobId, blobName, expiresAt, policyCommitment);

        _settlePaidBlob(registry, blobId, expiresAt, p1, p2, p3, p4);

        _assertSettled(registry, blobId, providerPool);
        require(address(p1).balance == providerRewardPerShard + providerReservePerShard, "provider one payout mismatch");
        require(address(p2).balance == providerRewardPerShard + providerReservePerShard, "provider two payout mismatch");
        require(address(p3).balance == providerRewardPerShard + providerReservePerShard, "provider three payout mismatch");
        require(address(p4).balance == providerRewardPerShard + providerReservePerShard, "provider four payout mismatch");
        require(registry.withdrawableProtocolFees() == protocolFee, "protocol fee should be withdrawable");
    }

    function testRecoveryReassignmentPaysImmediateOnceAndReplacementReserve() public {
        PrimeServerActor original = new PrimeServerActor();
        original.register(registry, "http://127.0.0.1:7101", bytes32(uint256(1)));
        PrimeServerActor replacement = new PrimeServerActor();
        PrimeServerActor user = new PrimeServerActor();
        bytes32 blobId = keccak256("reassigned-paid-shard");
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyCommitment = keccak256("reassignment-policy");

        (uint256 total, uint256 providerPool,, uint256 providerRewardPerShard,) =
            registry.quoteNativePayment(1024, 1, PrimeServerRegistry.StorageMode.Public, expiresAt);
        uint256 providerReservePerShard = providerPool - providerRewardPerShard;
        vm.deal(address(user), total);
        user.createNamedPaid{value: total}(
            registry,
            PrimeServerRegistry.PaidBlobRegistration({
                blobId: blobId,
                blobName: "paid/reassigned.bin",
                commitment: keccak256("reassigned-root"),
                size: 1024,
                chunkSize: 1024,
                dataShards: 1,
                totalShards: 1,
                expiresAt: expiresAt,
                storageMode: PrimeServerRegistry.StorageMode.Public,
                accessPolicy: PrimeServerRegistry.AccessPolicy.OwnerOnly,
                policyCommitment: policyCommitment,
                keyEnvelopeCommitment: bytes32(0),
                metadataCommitment: bytes32(0)
            })
        );

        uint256 originalId = registry.providerIdByOperator(address(original));
        registry.assignShard(blobId, 0, originalId);
        original.acknowledge(registry, blobId, 0, bytes32(uint256(501)), 1024);
        registry.finalizeBlob(blobId);

        uint8[] memory shard = new uint8[](1);
        shard[0] = 0;
        uint256 originalBalanceBefore = address(original).balance;
        original.claimSettlement(registry, blobId, shard);
        require(
            address(original).balance - originalBalanceBefore == providerRewardPerShard,
            "original provider should receive the immediate reward once"
        );
        require(registry.providerSettlementClaimed(blobId, 0, 0), "global immediate marker should be set");

        registry.startRecovery(blobId, 0);
        uint256 replacementId = replacement.register(registry, "http://127.0.0.1:7201", bytes32(uint256(2)));
        registry.reassignShard(blobId, 0, replacementId);
        replacement.acknowledge(registry, blobId, 0, bytes32(uint256(601)), 1024);
        registry.recordRebuiltShard(blobId, 0, replacementId, bytes32(uint256(601)));

        vm.warp(expiresAt + 1);
        uint256 replacementBalanceBefore = address(replacement).balance;
        replacement.claimSettlement(registry, blobId, shard);
        require(
            address(replacement).balance - replacementBalanceBefore == providerReservePerShard,
            "replacement provider should receive the reserve only"
        );
        require(registry.providerReserveClaimed(blobId, 0, 0), "global reserve marker should be set");

        _assertSettled(registry, blobId, providerPool);
    }

    function testNativeQuoteIncludesStorageDuration() public view {
        uint64 oneDay = uint64(block.timestamp + 1 days);
        uint64 sevenDays = uint64(block.timestamp + 7 days);
        (uint256 oneDayTotal, uint256 oneDayPool,,,) =
            registry.quoteNativePayment(2048, 4, PrimeServerRegistry.StorageMode.Public, oneDay);
        (uint256 sevenDayTotal, uint256 sevenDayPool,,,) =
            registry.quoteNativePayment(2048, 4, PrimeServerRegistry.StorageMode.Public, sevenDays);
        require(sevenDayTotal > oneDayTotal, "longer storage should cost more");
        require(sevenDayPool > oneDayPool, "longer storage should reserve more provider value");
    }

    function testConfidentialAccessBindsWalletDeviceAndNonce() public {
        uint256 userKey = 0x12345;
        address user = vm.addr(userKey);
        bytes32 blobId = keccak256("private-access-blob");
        bytes32 policyCommitment = keccak256("private-owner-only-policy");
        bytes32 keyEnvelopeCommitment = keccak256("fcc-key-envelope");
        uint64 expiresAt = uint64(block.timestamp + 7 days);
        (uint256 total,,,,) = registry.quoteNativePayment(1024, 4, PrimeServerRegistry.StorageMode.Private, expiresAt);
        vm.deal(user, total);
        vm.prank(user);
        registry.createBlobNamedPaid{value: total}(
            PrimeServerRegistry.PaidBlobRegistration({
                blobId: blobId,
                blobName: "opaque/private.bin",
                commitment: keccak256("private-root"),
                size: 1024,
                chunkSize: 1024,
                dataShards: 2,
                totalShards: 4,
                expiresAt: expiresAt,
                storageMode: PrimeServerRegistry.StorageMode.Private,
                accessPolicy: PrimeServerRegistry.AccessPolicy.OwnerOnly,
                policyCommitment: policyCommitment,
                keyEnvelopeCommitment: keyEnvelopeCommitment,
                metadataCommitment: keccak256("private-metadata")
            })
        );

        PrimeServerRegistry.ConfidentialAccessRequest memory request = PrimeServerRegistry.ConfidentialAccessRequest({
            blobId: blobId,
            requester: user,
            deviceKeyCommitment: keccak256("temporary-device-key"),
            nonce: 0,
            deadline: uint64(block.timestamp + 600),
            purpose: PrimeServerRegistry.AccessPurpose.View,
            exists: false,
            consumed: false
        });
        bytes32 digest = registry.hashConfidentialAccess(request);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        bytes32 requestId = registry.authorizeConfidentialAccess(request, abi.encodePacked(r, s, v));
        require(registry.isConfidentialAccessUsable(requestId), "fresh access request should be usable");
        require(registry.confidentialAccessNonces(blobId, user) == 1, "access nonce should advance");

        registry.setConfidentialAccessController(address(this), true);
        registry.recordConfidentialAccessResult(requestId, keccak256("device-wrapped-key"));
        require(!registry.isConfidentialAccessUsable(requestId), "consumed access request should not be reusable");

        (bool replaySucceeded,) = address(registry)
            .call(
                abi.encodeWithSelector(
                    registry.authorizeConfidentialAccess.selector, request, abi.encodePacked(r, s, v)
                )
            );
        require(!replaySucceeded, "access signature replay should be rejected");

        PrimeServerRegistry.ConfidentialAccessRequest memory expiredRequest = PrimeServerRegistry.ConfidentialAccessRequest({
            blobId: blobId,
            requester: user,
            deviceKeyCommitment: keccak256("second-device-key"),
            nonce: 1,
            deadline: uint64(block.timestamp + 600),
            purpose: PrimeServerRegistry.AccessPurpose.View,
            exists: false,
            consumed: false
        });
        bytes32 expiredDigest = registry.hashConfidentialAccess(expiredRequest);
        (v, r, s) = vm.sign(userKey, expiredDigest);
        bytes32 expiredRequestId = registry.authorizeConfidentialAccess(expiredRequest, abi.encodePacked(r, s, v));
        vm.warp(expiredRequest.deadline + 1);
        (bool expiredConsumeSucceeded,) = address(registry)
            .call(abi.encodeWithSelector(registry.recordConfidentialAccessResult.selector, expiredRequestId, keccak256("expired-key")));
        require(!expiredConsumeSucceeded, "expired access result should be rejected");
        require(!registry.isConfidentialAccessUsable(expiredRequestId), "expired access request should be unusable");

        PrimeServerRegistry.ConfidentialAccessRequest memory distantRequest = PrimeServerRegistry.ConfidentialAccessRequest({
            blobId: blobId,
            requester: user,
            deviceKeyCommitment: keccak256("distant-device-key"),
            nonce: 2,
            deadline: uint64(block.timestamp + 2 days),
            purpose: PrimeServerRegistry.AccessPurpose.View,
            exists: false,
            consumed: false
        });
        bytes32 distantDigest = registry.hashConfidentialAccess(distantRequest);
        (v, r, s) = vm.sign(userKey, distantDigest);
        (bool distantAuthorizeSucceeded,) = address(registry)
            .call(abi.encodeWithSelector(registry.authorizeConfidentialAccess.selector, distantRequest, abi.encodePacked(r, s, v)));
        require(!distantAuthorizeSucceeded, "distant access deadline should be rejected");
    }

    function _settlePaidBlob(
        PrimeServerRegistry target,
        bytes32 blobId,
        uint64 expiresAt,
        PrimeServerActor p1,
        PrimeServerActor p2,
        PrimeServerActor p3,
        PrimeServerActor p4
    ) internal {
        target.assignShard(blobId, 0, target.providerIdByOperator(address(p1)));
        target.assignShard(blobId, 1, target.providerIdByOperator(address(p2)));
        target.assignShard(blobId, 2, target.providerIdByOperator(address(p3)));
        target.assignShard(blobId, 3, target.providerIdByOperator(address(p4)));
        p1.acknowledge(target, blobId, 0, bytes32(uint256(100)), 1024);
        p2.acknowledge(target, blobId, 1, bytes32(uint256(101)), 1024);
        p3.acknowledge(target, blobId, 2, bytes32(uint256(102)), 1024);
        p4.acknowledge(target, blobId, 3, bytes32(uint256(103)), 1024);
        target.finalizeBlob(blobId);

        uint8[] memory shard0 = new uint8[](1);
        shard0[0] = 0;
        uint8[] memory shard1 = new uint8[](1);
        shard1[0] = 1;
        uint8[] memory shard2 = new uint8[](1);
        shard2[0] = 2;
        uint8[] memory shard3 = new uint8[](1);
        shard3[0] = 3;
        p1.claimSettlement(target, blobId, shard0);
        p2.claimSettlement(target, blobId, shard1);
        p3.claimSettlement(target, blobId, shard2);
        p4.claimSettlement(target, blobId, shard3);

        vm.warp(expiresAt + 1);
        p1.claimSettlement(target, blobId, shard0);
        p2.claimSettlement(target, blobId, shard1);
        p3.claimSettlement(target, blobId, shard2);
        p4.claimSettlement(target, blobId, shard3);
    }

    function _registerPaidBlob(
        PrimeServerRegistry target,
        PrimeServerActor user,
        bytes32 blobId,
        string memory blobName,
        uint64 expiresAt,
        bytes32 policyCommitment
    ) internal returns (uint256 providerPool, uint256 protocolFee, uint256 providerRewardPerShard, uint256 providerReservePerShard) {
        uint256 total;
        bytes32 quoteCommitment;
        (total, providerPool, protocolFee, providerRewardPerShard, quoteCommitment) =
            target.quoteNativePayment(2048, 4, PrimeServerRegistry.StorageMode.Public, expiresAt);
        providerReservePerShard = providerPool / 4 - providerRewardPerShard;
        vm.deal(address(user), total);

        PrimeServerRegistry.PaidBlobRegistration memory registration = PrimeServerRegistry.PaidBlobRegistration({
            blobId: blobId,
            blobName: blobName,
            commitment: keccak256("ciphertext-or-public-root"),
            size: 2048,
            chunkSize: 1024,
            dataShards: 2,
            totalShards: 4,
            expiresAt: expiresAt,
            storageMode: PrimeServerRegistry.StorageMode.Public,
            accessPolicy: PrimeServerRegistry.AccessPolicy.OwnerOnly,
            policyCommitment: policyCommitment,
            keyEnvelopeCommitment: bytes32(0),
            metadataCommitment: bytes32(0)
        });
        user.createNamedPaid{value: total}(target, registration);

        _assertPaidRegistration(target, blobId, user, expiresAt, policyCommitment);
        _assertEscrow(
            target,
            blobId,
            user,
            total,
            providerPool,
            protocolFee,
            providerRewardPerShard,
            quoteCommitment
        );
    }

    function _assertPaidRegistration(
        PrimeServerRegistry target,
        bytes32 blobId,
        PrimeServerActor user,
        uint64 expiresAt,
        bytes32 policyCommitment
    ) internal view {
        (address owner,,,,,,,, bool exists, uint64 storedExpiry, PrimeServerRegistry.BlobOrigin origin) =
            target.blobs(blobId);
        require(owner == address(user), "paid blob owner mismatch");
        require(exists, "paid blob should exist");
        require(storedExpiry == expiresAt, "paid expiry mismatch");
        require(origin == PrimeServerRegistry.BlobOrigin.User, "paid origin mismatch");

        PrimeServerRegistry.BlobPolicy memory policy = target.getBlobPolicy(blobId);
        require(policy.storageMode == PrimeServerRegistry.StorageMode.Public, "storage mode mismatch");
        require(policy.accessPolicy == PrimeServerRegistry.AccessPolicy.OwnerOnly, "access policy mismatch");
        require(policy.policyCommitment == policyCommitment, "policy commitment mismatch");
        require(policy.keyEnvelopeCommitment == bytes32(0), "public key envelope should be empty");
        require(policy.metadataCommitment == bytes32(0), "public metadata commitment should be empty");
    }

    function _assertEscrow(
        PrimeServerRegistry target,
        bytes32 blobId,
        PrimeServerActor user,
        uint256 total,
        uint256 providerPool,
        uint256 protocolFee,
        uint256 providerRewardPerShard,
        bytes32 quoteCommitment
    ) internal view {
        PrimeServerRegistry.BlobPayment memory payment = target.getBlobPayment(blobId);
        require(payment.asset == PrimeServerRegistry.PaymentAsset.NativeFlare, "payment asset mismatch");
        require(payment.status == PrimeServerRegistry.PaymentStatus.Escrowed, "payment should be escrowed");
        require(payment.payer == address(user), "payer mismatch");
        require(payment.totalPaid == total, "total payment mismatch");
        require(payment.providerPool == providerPool, "provider pool mismatch");
        require(payment.providerRewardPerShard == providerRewardPerShard, "provider reward mismatch");
        require(payment.protocolFee == protocolFee, "protocol fee mismatch");
        require(payment.providerSettled == 0, "providers should not be settled yet");
        require(payment.quoteCommitment == quoteCommitment, "quote commitment mismatch");
        require(payment.paidAt > 0, "payment timestamp missing");
        require(payment.settledAt == 0, "settlement timestamp should be empty");
    }

    function _assertSettled(PrimeServerRegistry target, bytes32 blobId, uint256 providerPool) internal view {
        PrimeServerRegistry.BlobPayment memory payment = target.getBlobPayment(blobId);
        require(payment.status == PrimeServerRegistry.PaymentStatus.Settled, "payment should be settled");
        require(payment.providerSettled == providerPool, "provider settlement total mismatch");
        require(payment.settledAt > 0, "settlement timestamp missing");
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
