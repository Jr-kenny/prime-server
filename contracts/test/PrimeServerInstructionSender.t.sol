// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrimeServerConfidentialRegistry} from "../src/fcc/IPrimeServerConfidentialRegistry.sol";
import {ITeeExtensionRegistry} from "../src/fcc/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/fcc/ITeeMachineRegistry.sol";
import {PrimeServerInstructionSender} from "../src/fcc/PrimeServerInstructionSender.sol";

interface PrimeServerFccVm {
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
}

contract PrimeServerConfidentialRegistryMock is IPrimeServerConfidentialRegistry {
    mapping(bytes32 requestId => ConfidentialAccessRequest request) internal requests;
    mapping(bytes32 blobId => BlobPolicy policy) internal policies;
    mapping(bytes32 requestId => bool usable) internal usableRequests;
    mapping(bytes32 blobId => address owner) internal blobOwners;

    bytes32 public recordedRequestId;
    bytes32 public recordedResponseCommitment;

    function setRequest(bytes32 requestId, ConfidentialAccessRequest calldata request, bool usable) external {
        requests[requestId] = request;
        usableRequests[requestId] = usable;
    }

    function setPolicy(bytes32 blobId, BlobPolicy calldata policy) external {
        policies[blobId] = policy;
    }

    function setBlobOwner(bytes32 blobId, address owner) external {
        blobOwners[blobId] = owner;
    }

    function getBlobPolicy(bytes32 blobId) external view returns (BlobPolicy memory) {
        return policies[blobId];
    }

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
        )
    {
        owner = blobOwners[blobId];
        commitment = bytes32(0);
        size = 0;
        chunkSize = 0;
        dataShards = 0;
        totalShards = 0;
        acknowledgementCount = 0;
        status = 0;
        exists = owner != address(0);
        expiresAt = 0;
        origin = 0;
    }

    function confidentialAccessRequests(bytes32 requestId)
        external
        view
        returns (ConfidentialAccessRequest memory)
    {
        return requests[requestId];
    }

    function isConfidentialAccessUsable(bytes32 requestId) external view returns (bool) {
        return usableRequests[requestId];
    }

    function recordConfidentialAccessResult(bytes32 requestId, bytes32 responseCommitment) external {
        recordedRequestId = requestId;
        recordedResponseCommitment = responseCommitment;
    }
}

contract TeeExtensionRegistryMock is ITeeExtensionRegistry {
    uint256 public nextPublicExtensionId = 0x10001;
    mapping(uint256 extensionId => address sender) public senders;
    bytes32 public lastOpType;
    bytes32 public lastOpCommand;
    bytes public lastMessage;
    address public lastClaimBackAddress;
    uint256 public lastFee;

    function setInstructionSender(uint256 extensionId, address sender) external {
        senders[extensionId] = sender;
    }

    function sendInstructions(address[] calldata, TeeInstructionParams calldata instructionParams)
        external
        payable
        returns (bytes32 instructionId)
    {
        lastOpType = instructionParams.opType;
        lastOpCommand = instructionParams.opCommand;
        lastMessage = instructionParams.message;
        lastClaimBackAddress = instructionParams.claimBackAddress;
        lastFee = msg.value;
        instructionId = keccak256(abi.encode(instructionParams.opType, instructionParams.opCommand, instructionParams.message));
    }

    function getTeeExtensionInstructionsSender(uint256 extensionId) external view returns (address) {
        return senders[extensionId];
    }
}

contract TeeMachineRegistryMock is ITeeMachineRegistry {
    function getRandomTeeIds(uint256, uint256 count) external pure returns (address[] memory teeIds) {
        teeIds = new address[](count);
        for (uint256 index = 0; index < count; index++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            teeIds[index] = address(uint160(index + 1));
        }
    }
}

contract PrimeServerInstructionSenderTest {
    PrimeServerFccVm internal constant vm = PrimeServerFccVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testKeyRewrapRequestBindsTheOnchainIntentAndEnvelope() public {
        PrimeServerConfidentialRegistryMock registry = new PrimeServerConfidentialRegistryMock();
        TeeExtensionRegistryMock teeExtensionRegistry = new TeeExtensionRegistryMock();
        TeeMachineRegistryMock teeMachineRegistry = new TeeMachineRegistryMock();
        address requester = address(0x1234);
        bytes32 requestId = keccak256("view-request");
        bytes32 blobId = keccak256("private-blob");
        bytes memory envelope = bytes("canonical-envelope");
        bytes memory devicePublicKey = bytes("device-public-key");

        registry.setPolicy(
            blobId,
            IPrimeServerConfidentialRegistry.BlobPolicy({
                storageMode: IPrimeServerConfidentialRegistry.StorageMode.Private,
                accessPolicy: 0,
                policyCommitment: bytes32(uint256(1)),
                keyEnvelopeCommitment: sha256(envelope),
                metadataCommitment: bytes32(uint256(2))
            })
        );
        registry.setBlobOwner(blobId, requester);
        registry.setRequest(
            requestId,
            IPrimeServerConfidentialRegistry.ConfidentialAccessRequest({
                blobId: blobId,
                requester: requester,
                deviceKeyCommitment: sha256(devicePublicKey),
                nonce: 0,
                deadline: 100,
                purpose: IPrimeServerConfidentialRegistry.AccessPurpose.View,
                exists: true,
                consumed: false
            }),
            true
        );

        PrimeServerInstructionSender sender = new PrimeServerInstructionSender(
            registry, teeExtensionRegistry, teeMachineRegistry, address(this)
        );
        teeExtensionRegistry.setInstructionSender(0x10000, address(sender));
        sender.setExtensionId();
        require(sender.extensionId() == 0x10000, "extension id mismatch");

        vm.deal(requester, 7);
        vm.prank(requester);
        bytes32 instructionId = sender.requestPrivateKeyRewrap{value: 7}(requestId, envelope, devicePublicKey);
        require(instructionId != bytes32(0), "instruction id missing");
        require(teeExtensionRegistry.lastOpType() == sender.OP_TYPE_PRIME_SERVER(), "op type mismatch");
        require(teeExtensionRegistry.lastOpCommand() == sender.OP_COMMAND_KEY_REWRAP(), "command mismatch");
        require(teeExtensionRegistry.lastFee() == 7, "fee mismatch");
        require(teeExtensionRegistry.lastClaimBackAddress() == requester, "claim back address mismatch");

        (bytes32 decodedRequestId, bytes32 decodedBlobId, address decodedBlobOwner, address decodedRequester, bytes32 decodedDeviceCommitment, bytes32 decodedEnvelopeCommitment, bytes memory decodedDeviceKey, bytes memory decodedEnvelope) =
            abi.decode(teeExtensionRegistry.lastMessage(), (bytes32, bytes32, address, address, bytes32, bytes32, bytes, bytes));
        require(decodedRequestId == requestId, "request id missing from message");
        require(decodedBlobId == blobId, "blob id missing from message");
        require(decodedBlobOwner == requester, "blob owner missing from message");
        require(decodedRequester == requester, "requester missing from message");
        require(decodedDeviceCommitment == sha256(devicePublicKey), "device commitment missing from message");
        require(decodedEnvelopeCommitment == sha256(envelope), "envelope commitment missing from message");
        require(keccak256(decodedDeviceKey) == keccak256(devicePublicKey), "device key missing from message");
        require(keccak256(decodedEnvelope) == keccak256(envelope), "envelope missing from message");
    }

    function testConfidentialComputeRequestUsesTheComputeIntentAndInputCommitment() public {
        PrimeServerConfidentialRegistryMock registry = new PrimeServerConfidentialRegistryMock();
        TeeExtensionRegistryMock teeExtensionRegistry = new TeeExtensionRegistryMock();
        TeeMachineRegistryMock teeMachineRegistry = new TeeMachineRegistryMock();
        address requester = address(0x5678);
        bytes32 requestId = keccak256("compute-request");
        bytes32 blobId = keccak256("confidential-blob");
        bytes memory envelope = bytes("canonical-compute-envelope");
        bytes memory computeSpec = bytes("{\"operation\":\"sha256\"}");
        bytes32 inputCommitment = keccak256("ciphertext");

        registry.setPolicy(
            blobId,
            IPrimeServerConfidentialRegistry.BlobPolicy({
                storageMode: IPrimeServerConfidentialRegistry.StorageMode.Confidential,
                accessPolicy: 2,
                policyCommitment: bytes32(uint256(3)),
                keyEnvelopeCommitment: sha256(envelope),
                metadataCommitment: bytes32(uint256(4))
            })
        );
        registry.setBlobOwner(blobId, requester);
        registry.setRequest(
            requestId,
            IPrimeServerConfidentialRegistry.ConfidentialAccessRequest({
                blobId: blobId,
                requester: requester,
                deviceKeyCommitment: bytes32(uint256(5)),
                nonce: 0,
                deadline: 100,
                purpose: IPrimeServerConfidentialRegistry.AccessPurpose.Compute,
                exists: true,
                consumed: false
            }),
            true
        );

        PrimeServerInstructionSender sender = new PrimeServerInstructionSender(
            registry, teeExtensionRegistry, teeMachineRegistry, address(this)
        );
        teeExtensionRegistry.setInstructionSender(0x10000, address(sender));
        sender.setExtensionId();

        vm.prank(requester);
        sender.requestConfidentialCompute(requestId, envelope, computeSpec, inputCommitment);
        require(teeExtensionRegistry.lastOpCommand() == sender.OP_COMMAND_CONFIDENTIAL_COMPUTE(), "compute command mismatch");
        (bytes32 decodedRequestId, bytes32 decodedBlobId, address decodedBlobOwner, address decodedRequester, bytes32 decodedEnvelopeCommitment, bytes memory decodedEnvelope, bytes memory decodedSpec, bytes32 decodedInputCommitment) =
            abi.decode(teeExtensionRegistry.lastMessage(), (bytes32, bytes32, address, address, bytes32, bytes, bytes, bytes32));
        require(decodedRequestId == requestId, "compute request id missing");
        require(decodedBlobId == blobId, "compute blob id missing");
        require(decodedBlobOwner == requester, "compute blob owner missing");
        require(decodedRequester == requester, "compute requester missing");
        require(decodedEnvelopeCommitment == sha256(envelope), "compute envelope commitment missing");
        require(keccak256(decodedEnvelope) == keccak256(envelope), "compute envelope missing");
        require(keccak256(decodedSpec) == keccak256(computeSpec), "compute spec missing");
        require(decodedInputCommitment == inputCommitment, "input commitment missing");
    }

    function testResultRelayIsRestrictedToConfiguredSubmitter() public {
        PrimeServerConfidentialRegistryMock registry = new PrimeServerConfidentialRegistryMock();
        TeeExtensionRegistryMock teeExtensionRegistry = new TeeExtensionRegistryMock();
        TeeMachineRegistryMock teeMachineRegistry = new TeeMachineRegistryMock();
        PrimeServerInstructionSender sender = new PrimeServerInstructionSender(
            registry, teeExtensionRegistry, teeMachineRegistry, address(this)
        );
        bytes32 requestId = keccak256("result-request");
        bytes32 responseCommitment = keccak256("device-key-package");

        sender.recordAccessResult(requestId, responseCommitment);
        require(registry.recordedRequestId() == requestId, "result request id mismatch");
        require(registry.recordedResponseCommitment() == responseCommitment, "result commitment mismatch");

        vm.prank(address(0x9999));
        (bool unauthorized,) = address(sender).call(
            abi.encodeWithSelector(sender.recordAccessResult.selector, requestId, responseCommitment)
        );
        require(!unauthorized, "unconfigured result submitter should be rejected");
    }
}
