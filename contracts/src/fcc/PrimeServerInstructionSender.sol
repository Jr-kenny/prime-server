// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrimeServerConfidentialRegistry} from "./IPrimeServerConfidentialRegistry.sol";
import {ITeeExtensionRegistry} from "./ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./ITeeMachineRegistry.sol";

/// @title Prime Server FCC Instruction Sender
/// @notice Sends wallet-bound key rewrap and confidential-compute requests to a Flare FCC extension.
/// @dev This contract is an adapter around the frozen PrimeServerRegistry. It does not store file keys,
///      ciphertext, attestation reports, or external payment state.
contract PrimeServerInstructionSender {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_PRIME_SERVER = bytes32("PRIME_SERVER");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_KEY_REWRAP = bytes32("KEY_REWRAP");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_CONFIDENTIAL_COMPUTE = bytes32("COMPUTE");

    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    IPrimeServerConfidentialRegistry public immutable PRIME_SERVER_REGISTRY;
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;
    address public immutable resultSubmitter;
    uint256 private _extensionId;

    event ExtensionIdSet(uint256 indexed extensionId);
    event FccInstructionRequested(
        bytes32 indexed requestId,
        bytes32 indexed blobId,
        bytes32 indexed instructionId,
        bytes32 opCommand,
        address requester
    );
    event FccAccessResultRecorded(bytes32 indexed requestId, bytes32 responseCommitment);

    constructor(
        IPrimeServerConfidentialRegistry primeServerRegistry,
        ITeeExtensionRegistry teeExtensionRegistry,
        ITeeMachineRegistry teeMachineRegistry,
        address resultSubmitter_
    ) {
        require(address(primeServerRegistry) != address(0), "registry is zero");
        require(address(teeExtensionRegistry) != address(0), "extension registry is zero");
        require(address(teeMachineRegistry) != address(0), "machine registry is zero");
        require(resultSubmitter_ != address(0), "result submitter is zero");
        require(address(primeServerRegistry).code.length > 0, "registry has no code");
        require(address(teeExtensionRegistry).code.length > 0, "extension registry has no code");
        require(address(teeMachineRegistry).code.length > 0, "machine registry has no code");

        PRIME_SERVER_REGISTRY = primeServerRegistry;
        TEE_EXTENSION_REGISTRY = teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = teeMachineRegistry;
        resultSubmitter = resultSubmitter_;
    }

    /// @notice Discovers this sender's public FCC extension ID after registration.
    function setExtensionId() external {
        require(_extensionId == 0, "extension id already set");
        uint256 nextId = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 candidateExtensionId = FIRST_PUBLIC_EXTENSION_ID; candidateExtensionId < nextId; candidateExtensionId++) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(candidateExtensionId) == address(this)) {
                _extensionId = candidateExtensionId;
                emit ExtensionIdSet(candidateExtensionId);
                return;
            }
        }
        revert("extension id not found");
    }

    function extensionId() external view returns (uint256) {
        return _extensionId;
    }

    /// @notice Requests an FCC key package encrypted for the current device public key.
    /// @param requestId Existing wallet-signed access intent recorded in PrimeServerRegistry.
    /// @param keyEnvelope Canonical JSON bytes of the FCC-sealed file-key envelope.
    /// @param devicePublicKey Ephemeral device public key whose SHA-256 commitment is in the intent.
    function requestPrivateKeyRewrap(bytes32 requestId, bytes calldata keyEnvelope, bytes calldata devicePublicKey)
        external
        payable
        returns (bytes32 instructionId)
    {
        IPrimeServerConfidentialRegistry.ConfidentialAccessRequest memory request = _usableRequest(requestId);
        IPrimeServerConfidentialRegistry.BlobPolicy memory policy = PRIME_SERVER_REGISTRY.getBlobPolicy(request.blobId);
        address blobOwner = _blobOwner(request.blobId);
        require(request.requester == msg.sender, "requester must send");
        require(request.purpose == IPrimeServerConfidentialRegistry.AccessPurpose.View, "view intent required");
        require(policy.storageMode == IPrimeServerConfidentialRegistry.StorageMode.Private, "private mode required");
        require(sha256(devicePublicKey) == request.deviceKeyCommitment, "device key mismatch");
        require(sha256(keyEnvelope) == policy.keyEnvelopeCommitment, "key envelope mismatch");

        bytes memory message = abi.encode(
            requestId,
            request.blobId,
            blobOwner,
            request.requester,
            request.deviceKeyCommitment,
            policy.keyEnvelopeCommitment,
            devicePublicKey,
            keyEnvelope
        );
        instructionId = _send(OP_COMMAND_KEY_REWRAP, message);
        emit FccInstructionRequested(requestId, request.blobId, instructionId, OP_COMMAND_KEY_REWRAP, request.requester);
    }

    /// @notice Requests a confidential operation over ciphertext retrieved through the FCC internal path.
    /// @param requestId Existing wallet-signed compute intent recorded in PrimeServerRegistry.
    /// @param keyEnvelope Canonical JSON bytes of the FCC-sealed file-key envelope.
    /// @param computeSpec Canonical operation description. It must not contain plaintext file bytes.
    /// @param inputCommitment SHA-256 commitment of the ciphertext the extension must retrieve.
    function requestConfidentialCompute(
        bytes32 requestId,
        bytes calldata keyEnvelope,
        bytes calldata computeSpec,
        bytes32 inputCommitment
    ) external payable returns (bytes32 instructionId) {
        IPrimeServerConfidentialRegistry.ConfidentialAccessRequest memory request = _usableRequest(requestId);
        IPrimeServerConfidentialRegistry.BlobPolicy memory policy = PRIME_SERVER_REGISTRY.getBlobPolicy(request.blobId);
        address blobOwner = _blobOwner(request.blobId);
        require(request.requester == msg.sender, "requester must send");
        require(request.purpose == IPrimeServerConfidentialRegistry.AccessPurpose.Compute, "compute intent required");
        require(policy.storageMode == IPrimeServerConfidentialRegistry.StorageMode.Confidential, "confidential mode required");
        require(keyEnvelope.length > 0, "key envelope required");
        require(computeSpec.length > 0, "compute spec required");
        require(inputCommitment != bytes32(0), "input commitment required");
        require(sha256(keyEnvelope) == policy.keyEnvelopeCommitment, "key envelope mismatch");

        bytes memory message = abi.encode(
            requestId,
            request.blobId,
            blobOwner,
            request.requester,
            policy.keyEnvelopeCommitment,
            keyEnvelope,
            computeSpec,
            inputCommitment
        );
        instructionId = _send(OP_COMMAND_CONFIDENTIAL_COMPUTE, message);
        emit FccInstructionRequested(
            requestId, request.blobId, instructionId, OP_COMMAND_CONFIDENTIAL_COMPUTE, request.requester
        );
    }

    /// @notice Relays a verified FCC result to the existing controller boundary.
    /// @dev The submitter is an explicit bridge while live FCC result attestation verification is being integrated.
    function recordAccessResult(bytes32 requestId, bytes32 responseCommitment) external {
        require(msg.sender == resultSubmitter, "not result submitter");
        require(responseCommitment != bytes32(0), "response commitment required");
        PRIME_SERVER_REGISTRY.recordConfidentialAccessResult(requestId, responseCommitment);
        emit FccAccessResultRecorded(requestId, responseCommitment);
    }

    function _usableRequest(bytes32 requestId)
        internal
        view
        returns (IPrimeServerConfidentialRegistry.ConfidentialAccessRequest memory request)
    {
        require(PRIME_SERVER_REGISTRY.isConfidentialAccessUsable(requestId), "access request unusable");
        request = PRIME_SERVER_REGISTRY.confidentialAccessRequests(requestId);
        require(request.exists && !request.consumed, "access request unavailable");
    }

    function _blobOwner(bytes32 blobId) internal view returns (address owner) {
        (owner,,,,,,,,,,) = PRIME_SERVER_REGISTRY.blobs(blobId);
        require(owner != address(0), "blob owner unavailable");
    }

    function _send(bytes32 opCommand, bytes memory message) internal returns (bytes32 instructionId) {
        require(_extensionId != 0, "extension id is not set");
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_extensionId, 1);
        require(teeIds.length > 0, "no TEE machines available");
        address[] memory cosigners = new address[](0);
        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_PRIME_SERVER,
            opCommand: opCommand,
            message: message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });
        instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }
}
