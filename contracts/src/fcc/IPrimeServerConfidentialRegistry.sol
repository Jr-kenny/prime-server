// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read and result-writing boundary exposed by the frozen PrimeServerRegistry.
interface IPrimeServerConfidentialRegistry {
    enum StorageMode {
        Public,
        Private,
        Confidential
    }

    enum AccessPurpose {
        View,
        Compute
    }

    struct BlobPolicy {
        StorageMode storageMode;
        uint8 accessPolicy;
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

    function getBlobPolicy(bytes32 blobId) external view returns (BlobPolicy memory);

    function blobs(bytes32 blobId)
        external
        view
        returns (
            address owner,
            bytes32 commitment,
            uint64 size,
            uint32 chunkSize,
            uint8 dataShards,
            uint8 totalShards,
            uint256 acknowledgementCount,
            uint8 status,
            bool exists,
            uint64 expiresAt,
            uint8 origin
        );

    function confidentialAccessRequests(bytes32 requestId)
        external
        view
        returns (ConfidentialAccessRequest memory);

    function isConfidentialAccessUsable(bytes32 requestId) external view returns (bool);

    function recordConfidentialAccessResult(bytes32 requestId, bytes32 responseCommitment) external;
}
