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

    enum BlobOrigin {
        User,
        Operator
    }

    enum StorageMode {
        Public,
        Private,
        Confidential
    }

    enum AccessPolicy {
        OwnerOnly,
        SelectedWallets,
        ComputeOnly
    }

    enum PaymentAsset {
        NativeFlare,
        FXRP,
        XRP
    }

    enum PaymentStatus {
        None,
        Escrowed,
        Claimable,
        PartiallySettled,
        Settled,
        Refunded
    }

    enum AccessPurpose {
        View,
        Compute
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
        BlobOrigin origin;
    }

    struct ShardAcknowledgement {
        bytes32 commitment;
        uint64 size;
        uint64 acknowledgedAt;
        bool exists;
    }

    struct BlobPolicy {
        StorageMode storageMode;
        AccessPolicy accessPolicy;
        bytes32 policyCommitment;
        bytes32 keyEnvelopeCommitment;
        bytes32 metadataCommitment;
    }

    struct BlobPayment {
        PaymentAsset asset;
        PaymentStatus status;
        address payer;
        uint256 totalPaid;
        uint256 providerPool;
        uint256 providerRewardPerShard;
        uint256 protocolFee;
        uint256 providerSettled;
        bytes32 quoteCommitment;
        uint64 paidAt;
        uint64 settledAt;
    }

    struct PaidBlobRegistration {
        bytes32 blobId;
        string blobName;
        bytes32 commitment;
        uint64 size;
        uint32 chunkSize;
        uint8 dataShards;
        uint8 totalShards;
        uint64 expiresAt;
        StorageMode storageMode;
        AccessPolicy accessPolicy;
        bytes32 policyCommitment;
        bytes32 keyEnvelopeCommitment;
        bytes32 metadataCommitment;
    }

    struct ConfidentialAccessRequest {
        bytes32 blobId;
        address requester;
        bytes32 deviceKeyCommitment;
        uint256 nonce;
        uint64 deadline;
        AccessPurpose purpose;
        bool exists;
        bool consumed;
    }

    uint256 public nextProviderId = 1;
    address public admin;
    mapping(address coordinator => bool) public coordinators;
    uint256 public nativeRatePerMiBPerShard = 1e12;
    uint16 public protocolFeeBps = 500;
    uint256 public withdrawableProtocolFees;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 private constant QUOTE_MIB_BYTES = 1_048_576;
    uint256 private constant QUOTE_DAY_SECONDS = 86_400;
    uint16 private constant PROVIDER_RESERVE_BPS = 1_000;
    uint64 private constant MAX_ACCESS_LIFETIME = 1 days;
    uint256 private constant GLOBAL_SETTLEMENT_PROVIDER_ID = 0;

    mapping(uint256 providerId => Provider provider) public providers;
    mapping(address operator => uint256 providerId) public providerIdByOperator;
    mapping(bytes32 blobId => Blob blob) public blobs;
    mapping(bytes32 blobId => bytes32 nameHash) public blobNameHashes;
    mapping(bytes32 blobId => string blobName) public blobNames;
    mapping(address owner => mapping(bytes32 nameHash => bytes32 blobId)) public blobIdByOwnerNameHash;
    mapping(bytes32 blobId => mapping(uint8 shardIndex => uint256 providerId)) public placement;
    mapping(bytes32 blobId => mapping(uint256 providerId => mapping(uint8 shardIndex => ShardAcknowledgement))) public
        acknowledgements;
    mapping(bytes32 blobId => BlobPolicy policy) public blobPolicies;
    mapping(bytes32 blobId => BlobPayment payment) public blobPayments;
    // Provider ID zero is reserved as the global per-shard claim marker. The
    // marker survives provider reassignment while the active placement still
    // determines which operator receives each payout.
    mapping(bytes32 blobId => mapping(uint256 providerId => mapping(uint8 shardIndex => bool))) public
        providerSettlementClaimed;
    mapping(bytes32 blobId => mapping(uint256 providerId => mapping(uint8 shardIndex => bool))) public
        providerReserveClaimed;
    mapping(address controller => bool) public confidentialAccessControllers;
    mapping(bytes32 blobId => mapping(address requester => uint256 nonce)) public confidentialAccessNonces;
    mapping(bytes32 requestId => ConfidentialAccessRequest request) public confidentialAccessRequests;
    mapping(bytes32 blobId => mapping(address wallet => bool allowed)) public selectedBlobWallets;

    bytes32 private constant CONFIDENTIAL_ACCESS_TYPEHASH = keccak256(
        "ConfidentialAccess(bytes32 blobId,address requester,bytes32 deviceKeyCommitment,uint256 nonce,uint64 deadline,uint8 purpose)"
    );
    uint256 private constant SECP256K1N_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    event ProviderRegistered(uint256 indexed providerId, address indexed operator, string endpoint, bytes32 signingKey);
    event ProviderStatusChanged(uint256 indexed providerId, bool active);
    event BlobCreated(bytes32 indexed blobId, address indexed owner, bytes32 commitment, uint64 size);
    event BlobNamed(bytes32 indexed blobId, address indexed owner, bytes32 indexed nameHash, string blobName);
    event ShardAssigned(bytes32 indexed blobId, uint8 indexed shardIndex, uint256 indexed providerId);
    event ShardAcknowledged(
        bytes32 indexed blobId, uint8 indexed shardIndex, uint256 indexed providerId, bytes32 commitment, uint64 size
    );
    event BlobFinalized(bytes32 indexed blobId);
    event RecoveryStarted(bytes32 indexed blobId, uint256 indexed providerId, uint8 indexed shardIndex);
    event ShardRebuilt(
        bytes32 indexed blobId, uint8 indexed shardIndex, uint256 indexed providerId, bytes32 commitment
    );
    event BlobPolicyRecorded(
        bytes32 indexed blobId,
        StorageMode storageMode,
        AccessPolicy accessPolicy,
        bytes32 policyCommitment,
        bytes32 keyEnvelopeCommitment,
        bytes32 metadataCommitment
    );
    event PaymentEscrowed(
        bytes32 indexed blobId,
        address indexed payer,
        PaymentAsset asset,
        uint256 amount,
        uint256 providerPool,
        uint256 protocolFee,
        bytes32 quoteCommitment
    );
    event ProviderSettlementClaimed(
        bytes32 indexed blobId, uint256 indexed providerId, address indexed operator, uint256 amount
    );
    event PaymentRefunded(bytes32 indexed blobId, address indexed payer, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);
    event NativePricingChanged(uint256 ratePerMiBPerShard, uint16 protocolFeeBps);
    event ConfidentialAccessControllerChanged(address indexed controller, bool allowed);
    event BlobWalletAccessChanged(bytes32 indexed blobId, address indexed wallet, bool allowed);
    event ConfidentialAccessAuthorized(
        bytes32 indexed requestId,
        bytes32 indexed blobId,
        address indexed requester,
        bytes32 deviceKeyCommitment,
        uint256 nonce,
        uint64 deadline,
        AccessPurpose purpose
    );
    event ConfidentialAccessConsumed(bytes32 indexed requestId, bytes32 indexed blobId, bytes32 responseCommitment);

    constructor() {
        admin = msg.sender;
        coordinators[msg.sender] = true;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Prime Server Registry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlyCoordinator() {
        require(coordinators[msg.sender], "not coordinator");
        _;
    }

    modifier onlyConfidentialAccessController() {
        require(confidentialAccessControllers[msg.sender], "not confidential access controller");
        _;
    }

    modifier onlyUser() {
        require(!coordinators[msg.sender], "coordinator must use operator creation");
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

    function setConfidentialAccessController(address controller, bool allowed) external onlyAdmin {
        require(controller != address(0), "invalid controller");
        confidentialAccessControllers[controller] = allowed;
        emit ConfidentialAccessControllerChanged(controller, allowed);
    }

    function setBlobWalletAccess(bytes32 blobId, address wallet, bool allowed) external onlyBlobOwner(blobId) {
        require(wallet != address(0), "invalid wallet");
        require(blobPolicies[blobId].accessPolicy == AccessPolicy.SelectedWallets, "selected wallet policy required");
        selectedBlobWallets[blobId][wallet] = allowed;
        emit BlobWalletAccessChanged(blobId, wallet, allowed);
    }

    function hashConfidentialAccess(ConfidentialAccessRequest calldata request) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CONFIDENTIAL_ACCESS_TYPEHASH,
                request.blobId,
                request.requester,
                request.deviceKeyCommitment,
                request.nonce,
                request.deadline,
                request.purpose
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function authorizeConfidentialAccess(ConfidentialAccessRequest calldata request, bytes calldata signature)
        external
        returns (bytes32 requestId)
    {
        Blob storage blob = blobs[request.blobId];
        BlobPolicy memory policy = blobPolicies[request.blobId];
        require(blob.exists, "blob does not exist");
        require(policy.storageMode != StorageMode.Public, "confidential access requires encrypted storage");
        require(request.requester != address(0), "requester required");
        require(request.deviceKeyCommitment != bytes32(0), "device key commitment required");
        require(blob.status != BlobStatus.Revoked, "revoked");
        require(blob.expiresAt == 0 || blob.expiresAt > block.timestamp, "expired");
        require(request.deadline >= block.timestamp, "expired");
        require(request.deadline <= block.timestamp + MAX_ACCESS_LIFETIME, "deadline");
        require(request.nonce == confidentialAccessNonces[request.blobId][request.requester], "invalid access nonce");
        if (policy.storageMode == StorageMode.Confidential || policy.accessPolicy == AccessPolicy.ComputeOnly) {
            require(request.purpose == AccessPurpose.Compute, "confidential storage is compute-only");
        } else {
            require(request.purpose == AccessPurpose.View, "private storage requires view access");
        }
        require(_isAccessAuthorized(request.blobId, request.requester, policy.accessPolicy), "wallet is not authorized");

        bytes32 digest = hashConfidentialAccess(request);
        require(_recoverSigner(digest, signature) == request.requester, "invalid access signature");
        requestId = digest;
        confidentialAccessNonces[request.blobId][request.requester] = request.nonce + 1;
        confidentialAccessRequests[requestId] = ConfidentialAccessRequest({
            blobId: request.blobId,
            requester: request.requester,
            deviceKeyCommitment: request.deviceKeyCommitment,
            nonce: request.nonce,
            deadline: request.deadline,
            purpose: request.purpose,
            exists: true,
            consumed: false
        });
        emit ConfidentialAccessAuthorized(
            requestId,
            request.blobId,
            request.requester,
            request.deviceKeyCommitment,
            request.nonce,
            request.deadline,
            request.purpose
        );
    }

    function recordConfidentialAccessResult(bytes32 requestId, bytes32 responseCommitment)
        external
        onlyConfidentialAccessController
    {
        ConfidentialAccessRequest storage request = confidentialAccessRequests[requestId];
        require(responseCommitment != bytes32(0), "response commitment required");
        require(_isConfidentialAccessUsable(request), "access unusable");
        request.consumed = true;
        emit ConfidentialAccessConsumed(requestId, request.blobId, responseCommitment);
    }

    function isConfidentialAccessUsable(bytes32 requestId) external view returns (bool) {
        return _isConfidentialAccessUsable(confidentialAccessRequests[requestId]);
    }

    function _isConfidentialAccessUsable(ConfidentialAccessRequest memory request) internal view returns (bool) {
        Blob memory blob = blobs[request.blobId];
        BlobPolicy memory policy = blobPolicies[request.blobId];
        return request.exists && !request.consumed && request.deadline >= block.timestamp && blob.exists
            && blob.status != BlobStatus.Revoked && (blob.expiresAt == 0 || blob.expiresAt > block.timestamp)
            && _isAccessAuthorized(request.blobId, request.requester, policy.accessPolicy);
    }

    function _isAccessAuthorized(bytes32 blobId, address requester, AccessPolicy accessPolicy)
        internal
        view
        returns (bool)
    {
        if (blobs[blobId].owner == requester) return true;
        return accessPolicy == AccessPolicy.SelectedWallets && selectedBlobWallets[blobId][requester];
    }

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        require(signature.length == 65, "signature must be 65 bytes");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= SECP256K1N_HALF_ORDER, "signature s value is too high");
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid signature v value");
        signer = ecrecover(digest, v, r, s);
    }

    function setNativePricing(uint256 ratePerMiBPerShard, uint16 feeBps) external onlyAdmin {
        require(ratePerMiBPerShard > 0, "rate required");
        require(feeBps <= 10_000, "fee too high");
        nativeRatePerMiBPerShard = ratePerMiBPerShard;
        protocolFeeBps = feeBps;
        emit NativePricingChanged(ratePerMiBPerShard, feeBps);
    }

    function quoteNativePayment(uint64 size, uint8 totalShards, StorageMode storageMode, uint64 expiresAt)
        public
        view
        returns (
            uint256 total,
            uint256 providerPool,
            uint256 protocolFee,
            uint256 providerRewardPerShard,
            bytes32 quoteCommitment
        )
    {
        require(size > 0, "size required");
        require(totalShards > 0, "shards required");
        require(expiresAt > block.timestamp, "expiry");

        uint256 mibCount = (uint256(size) + QUOTE_MIB_BYTES - 1) / QUOTE_MIB_BYTES;
        uint256 durationDays = (uint256(expiresAt) - block.timestamp + QUOTE_DAY_SECONDS - 1) / QUOTE_DAY_SECONDS;
        uint256 multiplierBps = _modeMultiplierBps(storageMode);
        uint256 grossProviderRewardPerShard =
            (mibCount * nativeRatePerMiBPerShard * multiplierBps * durationDays + 9_999) / 10_000;
        uint256 providerReservePerShard = (grossProviderRewardPerShard * PROVIDER_RESERVE_BPS + 9_999) / 10_000;
        providerRewardPerShard = grossProviderRewardPerShard - providerReservePerShard;
        providerPool = grossProviderRewardPerShard * totalShards;
        protocolFee = (providerPool * protocolFeeBps + 9_999) / 10_000;
        total = providerPool + protocolFee;
        quoteCommitment = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                size,
                totalShards,
                storageMode,
                expiresAt,
                durationDays,
                nativeRatePerMiBPerShard,
                protocolFeeBps,
                PROVIDER_RESERVE_BPS,
                total,
                providerPool,
                protocolFee
            )
        );
    }

    function getBlobPolicy(bytes32 blobId) external view returns (BlobPolicy memory) {
        return blobPolicies[blobId];
    }

    function getBlobPayment(bytes32 blobId) external view returns (BlobPayment memory) {
        return blobPayments[blobId];
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
    ) external onlyUser {
        _createBlob(
            msg.sender, blobId, "", commitment, size, chunkSize, dataShards, totalShards, 0, false, BlobOrigin.User
        );
    }

    function createBlobWithExpiry(
        bytes32 blobId,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external onlyUser {
        _createBlob(
            msg.sender,
            blobId,
            "",
            commitment,
            size,
            chunkSize,
            dataShards,
            totalShards,
            expiresAt,
            false,
            BlobOrigin.User
        );
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
    ) external onlyUser {
        _createBlob(
            msg.sender,
            blobId,
            blobName,
            commitment,
            size,
            chunkSize,
            dataShards,
            totalShards,
            expiresAt,
            true,
            BlobOrigin.User
        );
    }

    function createBlobPaid(PaidBlobRegistration calldata registration) external payable onlyUser {
        require(bytes(registration.blobName).length == 0, "unexpected blob name");
        _createPaidBlob(registration);
    }

    function createBlobNamedPaid(PaidBlobRegistration calldata registration) external payable onlyUser {
        require(bytes(registration.blobName).length > 0, "blob name required");
        _createPaidBlob(registration);
    }

    function createOperatorBlob(
        bytes32 blobId,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external onlyCoordinator {
        _createBlob(
            msg.sender,
            blobId,
            "",
            commitment,
            size,
            chunkSize,
            dataShards,
            totalShards,
            expiresAt,
            false,
            BlobOrigin.Operator
        );
    }

    function createOperatorBlobNamed(
        bytes32 blobId,
        string calldata blobName,
        bytes32 commitment,
        uint64 size,
        uint32 chunkSize,
        uint8 dataShards,
        uint8 totalShards,
        uint64 expiresAt
    ) external onlyCoordinator {
        _createBlob(
            msg.sender,
            blobId,
            blobName,
            commitment,
            size,
            chunkSize,
            dataShards,
            totalShards,
            expiresAt,
            true,
            BlobOrigin.Operator
        );
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
        bool named,
        BlobOrigin origin
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
            expiresAt: expiresAt,
            origin: origin
        });

        emit BlobCreated(blobId, owner, commitment, size);
        if (named) {
            blobIdByOwnerNameHash[owner][nameHash] = blobId;
            blobNameHashes[blobId] = nameHash;
            blobNames[blobId] = blobName;
            emit BlobNamed(blobId, owner, nameHash, blobName);
        }
    }

    function _createPaidBlob(PaidBlobRegistration calldata registration) internal {
        require(registration.expiresAt > block.timestamp, "paid blob expiry required");
        _validatePolicy(
            registration.storageMode,
            registration.accessPolicy,
            registration.policyCommitment,
            registration.keyEnvelopeCommitment
        );
        (
            uint256 total,
            uint256 providerPool,
            uint256 protocolFee,
            uint256 providerRewardPerShard,
            bytes32 quoteCommitment
        ) = quoteNativePayment(
            registration.size, registration.totalShards, registration.storageMode, registration.expiresAt
        );
        require(msg.value >= total, "incorrect native payment");

        _createUserBlob(registration);

        blobPolicies[registration.blobId] = BlobPolicy({
            storageMode: registration.storageMode,
            accessPolicy: registration.accessPolicy,
            policyCommitment: registration.policyCommitment,
            keyEnvelopeCommitment: registration.keyEnvelopeCommitment,
            metadataCommitment: registration.metadataCommitment
        });
        blobPayments[registration.blobId] = BlobPayment({
            asset: PaymentAsset.NativeFlare,
            status: PaymentStatus.Escrowed,
            payer: msg.sender,
            totalPaid: total,
            providerPool: providerPool,
            providerRewardPerShard: providerRewardPerShard,
            protocolFee: protocolFee,
            providerSettled: 0,
            quoteCommitment: quoteCommitment,
            paidAt: uint64(block.timestamp),
            settledAt: 0
        });
        emit BlobPolicyRecorded(
            registration.blobId,
            registration.storageMode,
            registration.accessPolicy,
            registration.policyCommitment,
            registration.keyEnvelopeCommitment,
            registration.metadataCommitment
        );
        emit PaymentEscrowed(
            registration.blobId, msg.sender, PaymentAsset.NativeFlare, total, providerPool, protocolFee, quoteCommitment
        );
        uint256 excess = msg.value - total;
        if (excess > 0) {
            (bool success,) = payable(msg.sender).call{value: excess}("");
            require(success, "refund failed");
        }
    }

    function _createUserBlob(PaidBlobRegistration calldata registration) internal {
        _createBlob(
            msg.sender,
            registration.blobId,
            registration.blobName,
            registration.commitment,
            registration.size,
            registration.chunkSize,
            registration.dataShards,
            registration.totalShards,
            registration.expiresAt,
            bytes(registration.blobName).length > 0,
            BlobOrigin.User
        );
    }

    function _validatePolicy(
        StorageMode storageMode,
        AccessPolicy accessPolicy,
        bytes32 policyCommitment,
        bytes32 keyEnvelopeCommitment
    ) internal pure {
        require(policyCommitment != bytes32(0), "policy commitment required");
        if (storageMode == StorageMode.Public) {
            require(keyEnvelopeCommitment == bytes32(0), "public key envelope forbidden");
        } else {
            require(keyEnvelopeCommitment != bytes32(0), "key envelope commitment required");
        }
        if (accessPolicy == AccessPolicy.ComputeOnly) {
            require(storageMode == StorageMode.Confidential, "compute access requires confidential mode");
        }
        if (storageMode == StorageMode.Confidential) {
            require(accessPolicy == AccessPolicy.ComputeOnly, "confidential mode requires compute access");
        }
    }

    function _modeMultiplierBps(StorageMode storageMode) internal pure returns (uint256) {
        if (storageMode == StorageMode.Private) return 12_000;
        if (storageMode == StorageMode.Confidential) return 15_000;
        return 10_000;
    }

    function assignShard(bytes32 blobId, uint8 shardIndex, uint256 providerId)
        external
        onlyBlobOwnerOrCoordinator(blobId)
    {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Pending, "blob not pending");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(providers[providerId].active, "provider inactive");
        require(placement[blobId][shardIndex] == 0, "shard already assigned");

        placement[blobId][shardIndex] = providerId;
        emit ShardAssigned(blobId, shardIndex, providerId);
    }

    function acknowledgeShard(bytes32 blobId, uint8 shardIndex, bytes32 shardCommitment, uint64 shardSize) external {
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
            commitment: shardCommitment, size: shardSize, acknowledgedAt: uint64(block.timestamp), exists: true
        });

        emit ShardAcknowledged(blobId, shardIndex, providerId, shardCommitment, shardSize);
    }

    function finalizeBlob(bytes32 blobId) external onlyBlobOwnerOrCoordinator(blobId) {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Pending, "blob not pending");
        require(blob.acknowledgementCount == blob.totalShards, "missing acknowledgements");
        blob.status = BlobStatus.Active;
        if (blobPayments[blobId].status == PaymentStatus.Escrowed) {
            blobPayments[blobId].status = PaymentStatus.Claimable;
        }
        emit BlobFinalized(blobId);
    }

    function claimProviderSettlement(bytes32 blobId, uint8[] calldata shardIndices) external returns (uint256 amount) {
        Blob storage blob = blobs[blobId];
        BlobPayment storage payment = blobPayments[blobId];
        require(blob.exists, "blob does not exist");
        require(blob.status == BlobStatus.Active || blob.status == BlobStatus.Rebuilt, "blob not settled");
        require(
            payment.status == PaymentStatus.Claimable || payment.status == PaymentStatus.PartiallySettled,
            "payment not claimable"
        );

        uint256 providerId = providerIdByOperator[msg.sender];
        require(providerId != 0, "provider not registered");
        require(providers[providerId].active, "provider inactive");
        require(shardIndices.length > 0, "shards required");

        uint256 reserveAmount;
        uint256 reservePerShard = payment.providerPool / blob.totalShards - payment.providerRewardPerShard;
        for (uint256 index = 0; index < shardIndices.length; index++) {
            uint8 shardIndex = shardIndices[index];
            require(shardIndex < blob.totalShards, "invalid shard index");
            require(placement[blobId][shardIndex] == providerId, "provider not assigned");
            require(acknowledgements[blobId][providerId][shardIndex].exists, "shard not acknowledged");
            if (!providerSettlementClaimed[blobId][GLOBAL_SETTLEMENT_PROVIDER_ID][shardIndex]) {
                providerSettlementClaimed[blobId][GLOBAL_SETTLEMENT_PROVIDER_ID][shardIndex] = true;
                amount += payment.providerRewardPerShard;
            }
            if (
                block.timestamp >= blob.expiresAt
                    && !providerReserveClaimed[blobId][GLOBAL_SETTLEMENT_PROVIDER_ID][shardIndex]
            ) {
                providerReserveClaimed[blobId][GLOBAL_SETTLEMENT_PROVIDER_ID][shardIndex] = true;
                reserveAmount += reservePerShard;
            }
        }

        amount += reserveAmount;
        require(amount > 0, "settlement is empty");
        payment.providerSettled += amount;
        require(payment.providerSettled <= payment.providerPool, "provider pool exhausted");
        if (payment.providerSettled == payment.providerPool) {
            payment.status = PaymentStatus.Settled;
            payment.settledAt = uint64(block.timestamp);
            withdrawableProtocolFees += payment.protocolFee;
        } else {
            payment.status = PaymentStatus.PartiallySettled;
        }

        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success, "provider payment failed");
        emit ProviderSettlementClaimed(blobId, providerId, msg.sender, amount);
    }

    function refundPaidBlob(bytes32 blobId) external onlyBlobOwner(blobId) {
        Blob storage blob = blobs[blobId];
        BlobPayment storage payment = blobPayments[blobId];
        require(payment.status == PaymentStatus.Escrowed, "payment not refundable");
        require(blob.status == BlobStatus.Pending, "blob is already active");
        require(blob.expiresAt > 0 && block.timestamp > blob.expiresAt, "refund window not open");

        payment.status = PaymentStatus.Refunded;
        uint256 amount = payment.totalPaid;
        (bool success,) = payable(payment.payer).call{value: amount}("");
        require(success, "refund failed");
        emit PaymentRefunded(blobId, payment.payer, amount);
    }

    function withdrawProtocolFees(address payable recipient, uint256 amount) external onlyAdmin {
        require(recipient != address(0), "recipient required");
        require(amount > 0 && amount <= withdrawableProtocolFees, "invalid fee amount");
        withdrawableProtocolFees -= amount;
        (bool success,) = recipient.call{value: amount}("");
        require(success, "fee withdrawal failed");
        emit ProtocolFeesWithdrawn(recipient, amount);
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

    function reassignShard(bytes32 blobId, uint8 shardIndex, uint256 providerId)
        external
        onlyBlobOwnerOrCoordinator(blobId)
    {
        Blob storage blob = blobs[blobId];
        require(blob.status == BlobStatus.Recovering, "recovery not active");
        require(shardIndex < blob.totalShards, "invalid shard index");
        require(providers[providerId].active, "provider inactive");
        placement[blobId][shardIndex] = providerId;
        emit ShardAssigned(blobId, shardIndex, providerId);
    }

    function recordRebuiltShard(bytes32 blobId, uint8 shardIndex, uint256 providerId, bytes32 shardCommitment)
        external
        onlyBlobOwnerOrCoordinator(blobId)
    {
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
