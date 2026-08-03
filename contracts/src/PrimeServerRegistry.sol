// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Prime Server Registry
/// @notice Minimal onchain coordination surface for the first Prime Server network.
/// @dev File bytes remain offchain. This contract records commitments and state transitions.
contract PrimeServerRegistry {
    enum BlobStatus {
        Pending,
        Active,
        Recovering,
        Rebuilt,
        Revoked
    }

    struct Provider {
        address operator;
        string endpoint;
        bytes32 signingKey;
        bool active;
        uint64 registeredAt;
    }

    struct Blob {
        address owner;
        bytes32 commitment;
        uint64 size;
        uint32 chunkSize;
        uint8 dataShards;
        uint8 totalShards;
        uint256 acknowledgementCount;
        BlobStatus status;
        bool exists;
        uint64 expiresAt;
    }

    struct ShardAcknowledgement {
        bytes32 commitment;
        uint64 size;
        uint64 acknowledgedAt;
        bool exists;
    }

    uint256 public nextProviderId = 1;
    address public admin;
    mapping(address coordinator => bool) public coordinators;

    mapping(uint256 providerId => Provider provider) public providers;
    mapping(address operator => uint256 providerId) public providerIdByOperator;
    mapping(bytes32 blobId => Blob blob) public blobs;
    mapping(bytes32 blobId => bytes32 nameHash) public blobNameHashes;
    mapping(bytes32 blobId => string blobName) public blobNames;
    mapping(address owner => mapping(bytes32 nameHash => bytes32 blobId)) public blobIdByOwnerNameHash;
    mapping(bytes32 blobId => mapping(uint8 shardIndex => uint256 providerId)) public placement;
    mapping(bytes32 blobId => mapping(uint256 providerId => mapping(uint8 shardIndex => ShardAcknowledgement)))
        public acknowledgements;

    event ProviderRegistered(uint256 indexed providerId, address indexed operator, string endpoint, bytes32 signingKey);
    event ProviderStatusChanged(uint256 indexed providerId, bool active);
    event BlobCreated(bytes32 indexed blobId, address indexed owner, bytes32 commitment, uint64 size);
    event BlobNamed(bytes32 indexed blobId, address indexed owner, bytes32 indexed nameHash, string blobName);
    event ShardAssigned(bytes32 indexed blobId, uint8 indexed shardIndex, uint256 indexed providerId);
    event ShardAcknowledged(
        bytes32 indexed blobId,
        uint8 indexed shardIndex,
        uint256 indexed providerId,
        bytes32 commitment,
        uint64 size
    );
    event BlobFinalized(bytes32 indexed blobId);
    event RecoveryStarted(bytes32 indexed blobId, uint256 indexed providerId, uint8 indexed shardIndex);
    event ShardRebuilt(
        bytes32 indexed blobId,
        uint8 indexed shardIndex,
        uint256 indexed providerId,
        bytes32 commitment
    );

    constructor() {
        admin = msg.sender;
        coordinators[msg.sender] = true;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyCoordinator() {
        require(coordinators[msg.sender], "not coordinator");
        _;
    }

    modifier onlyBlobOwner(bytes32 blobId) {
        require(blobs[blobId].exists, "blob does not exist");
        require(blobs[blobId].owner == msg.sender, "not blob owner");
        _;
    }

    modifier onlyBlobOwnerOrCoordinator(bytes32 blobId) {
        require(blobs[blobId].exists, "blob does not exist");
        require(blobs[blobId].owner == msg.sender || coordinators[msg.sender], "not blob controller");
        _;
    }

    function setCoordinator(address coordinator, bool allowed) external onlyAdmin {
        require(coordinator != address(0), "invalid coordinator");
        coordinators[coordinator] = allowed;
    }

    function registerProvider(string calldata endpoint, bytes32 signingKey) external returns (uint256 providerId) {
        require(msg.sender != address(0), "invalid operator");
        require(providerIdByOperator[msg.sender] == 0, "provider already registered");
        require(bytes(endpoint).length > 0, "endpoint required");
        require(signingKey != bytes32(0), "signing key required");

        providerId = nextProviderId++;
        providers[providerId] = Provider({
            operator: msg.sender,
            endpoint: endpoint,
            signingKey: signingKey,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        providerIdByOperator[msg.sender] = providerId;

        emit ProviderRegistered(providerId, msg.sender, endpoint, signingKey);
    }

    function setProviderStatus(uint256 providerId, bool active) external {
        Provider storage provider = providers[providerId];
        require(provider.operator == msg.sender, "not provider operator");
        provider.active = active;
        emit ProviderStatusChanged(providerId, active);
    }

    function createBlob(
        bytes32 blobId,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards
    ) external {
        _createBlob(msg.sender, blobId, "", commitment, size, chunkSize, dataShards, totalShards, 0, false);
    }

    function createBlobWithExpiry(
        bytes32 blobId,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external {
        _createBlob(msg.sender, blobId, "", commitment, size, chunkSize, dataShards, totalShards, expiresAt, false);
    }

    function createBlobNamed(
        bytes32 blobId,
        string calldata blobName,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external {
        _createBlob(msg.sender, blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt, true);
    }

    function createBlobFor(
        address owner,
        bytes32 blobId,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external onlyCoordinator {
        _createBlob(owner, blobId, "", commitment, size, chunkSize, dataShards, totalShards, expiresAt, false);
    }

    function createBlobForNamed(
        address owner,
        bytes32 blobId,
        string calldata blobName,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external onlyCoordinator {
        _createBlob(owner, blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt, true);
    }

    function _createBlob(
        address owner,
        bytes32 blobId,
        string memory blobName,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt,
        bool named
    ) internal {
        require(owner != address(0), "owner required");
        require(!blobs[blobId].exists, "blob already exists");
        require(blobId != bytes32(0), "blob id required");
        require(commitment != bytes32(0), "commitment required");
        require(size > 0, "size required");
        require(chunkSize > 0, "chunk size required");
        require(dataShards > 0, "data shards required");
        require(totalShards >= dataShards, "invalid shard count");
        require(expiresAt == 0 || expiresAt > block.timestamp, "invalid expiry");

        bytes memory encodedName = bytes(blobName);
        bytes32 nameHash;
        if (named) {
            require(encodedName.length > 0, "blob name required");
            require(encodedName.length <= 1024, "blob name too long");
            require(encodedName[0] != 0x2f, "blob name cannot start with slash");
            require(encodedName[encodedName.length - 1] != 0x2f, "blob name cannot end with slash");
            nameHash = keccak256(encodedName);
            require(blobIdByOwnerNameHash[owner][nameHash] == bytes32(0), "blob name already exists");
        } else {
            require(encodedName.length == 0, "unexpected blob name");
        }

        blobs[blobId] = Blob({
            owner: owner,
            commitment: commitment,
            size: size,
            chunkSize: chunkSize,
            dataShards: dataShards,
            totalShards: totalShards,
            acknowledgementCount: 0,
            status: BlobStatus.Pending,
            exists: true,
            expiresAt: expiresAt
        });

        emit BlobCreated(blobId, owner, commitment, size);
        if (named) {
            blobIdByOwnerNameHash[owner][nameHash] = blobId;
            blobNameHashes[blobId] = nameHash;
            blobNames[blobId] = blobName;
            emit BlobNamed(blobId, owner, nameHash, blobName);
        }
    }

    function assignShard(bytes32 blobId, uint8 shardIndex, uint256 providerId) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Pending, "blob not pending");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(providers[providerId].active, "provider inactive");
        require(placement[blobId][shardIndex] == 0, "shard already assigned");

        placement[blobId][shardIndex] = providerId;
        emit ShardAssigned(blobId, shardIndex, providerId);
    }

    function acknowledgeShard(
        bytes32 blobId,
        uint8 shardIndex,
        bytes32 shardCommitment,
        uint64 shardSize
    ) external {
        Blob storage blob = blobs[blobId];
        require(blob.exists, "blob does not exist");
        require(blob.status == BlobStatus.Pending || blob.status == BlobStatus.Recovering, "blob not writable");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(shardCommitment != bytes32(0), "shard commitment required");
        require(shardSize > 0, "shard size required");

        uint256 providerId = providerIdByOperator[msg.sender];
        require(providerId != 0, "provider not registered");
        require(providers[providerId].active, "provider inactive");
        require(placement[blobId][shardIndex] == providerId, "provider not assigned");

        ShardAcknowledgement storage acknowledgement = acknowledgements[blobId][providerId][shardIndex];
        if (!acknowledgement.exists) {
            blob.acknowledgementCount += 1;
        }

        acknowledgements[blobId][providerId][shardIndex] = ShardAcknowledgement({
            commitment: shardCommitment,
            size: shardSize,
            acknowledgedAt: uint64(block.timestamp),
            exists: true
        });

        emit ShardAcknowledged(blobId, shardIndex, providerId, shardCommitment, shardSize);
    }

    function finalizeBlob(bytes32 blobId) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Pending, "blob not pending");
        require(blob.acknowledgementCount == blob.totalShards, "missing acknowledgements");
        blob.status = BlobStatus.Active;
        emit BlobFinalized(blobId);
    }

    function startRecovery(bytes32 blobId, uint8 shardIndex) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Active || blob.status == BlobStatus.Rebuilt, "blob not active");
        require(shardIndex < blob.totalShards, "invalid shard index");
        uint256 providerId = placement[blobId][shardIndex];
        require(providerId != 0, "shard not assigned");
        blob.status = BlobStatus.Recovering;
        emit RecoveryStarted(blobId, providerId, shardIndex);
    }

    function reassignShard(bytes32 blobId, uint8 shardIndex, uint256 providerId) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Recovering, "recovery not active");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(providers[providerId].active, "provider inactive");
        placement[blobId][shardIndex] = providerId;
        emit ShardAssigned(blobId, shardIndex, providerId);
    }

    function recordRebuiltShard(
        bytes32 blobId,
        uint8 shardIndex,
        uint256 providerId,
        bytes32 shardCommitment
    ) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Recovering, "recovery not active");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(placement[blobId][shardIndex] == providerId, "provider not assigned");
        require(providerId != 0, "shard not assigned");
        require(shardCommitment != bytes32(0), "commitment required");
        blob.status = BlobStatus.Rebuilt;
        emit ShardRebuilt(blobId, shardIndex, providerId, shardCommitment);
    }
}
