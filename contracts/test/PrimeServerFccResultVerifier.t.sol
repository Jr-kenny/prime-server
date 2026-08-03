// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITeeMachineRegistryResultVerifier} from "../src/fcc/ITeeMachineRegistryResultVerifier.sol";
import {IPrimeServerInstructionResultSink, PrimeServerFccResultVerifier} from "../src/fcc/PrimeServerFccResultVerifier.sol";

interface PrimeServerFccVerifierVm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract TeeMachineResultRegistryMock is ITeeMachineRegistryResultVerifier {
    mapping(address teeId => TeeMachine machine) internal machines;
    mapping(address teeId => uint256 extensionId) internal extensions;

    function setMachine(address teeId, uint256 extensionId) external {
        machines[teeId] = TeeMachine({teeId: teeId, teeProxyId: address(0x1234), url: "https://fcc.example"});
        extensions[teeId] = extensionId;
    }

    function getTeeMachine(address teeId) external view returns (TeeMachine memory) {
        return machines[teeId];
    }

    function getExtensionId(address teeId) external view returns (uint256) {
        return extensions[teeId];
    }
}

contract PrimeServerInstructionResultSinkMock {
    mapping(bytes32 instructionId => bytes32 requestId) public requestIds;
    bytes32 public recordedRequestId;
    bytes32 public recordedResponseCommitment;

    function setInstruction(bytes32 instructionId, bytes32 requestId) external {
        requestIds[instructionId] = requestId;
    }

    function requestIdByInstructionId(bytes32 instructionId) external view returns (bytes32) {
        return requestIds[instructionId];
    }

    function recordAccessResult(bytes32 requestId, bytes32 responseCommitment) external {
        recordedRequestId = requestId;
        recordedResponseCommitment = responseCommitment;
    }
}

contract PrimeServerFccResultVerifierTest {
    PrimeServerFccVerifierVm internal constant vm = PrimeServerFccVerifierVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testOfficialActionResultSignatureIsVerifiedAndRelayed() public {
        uint256 teePrivateKey = 0xA11CE;
        address teeId = vm.addr(teePrivateKey);
        uint256 extensionId = 65922;
        bytes32 requestId = keccak256("access-request");
        bytes32 instructionId = keccak256("instruction");
        bytes memory resultData = bytes("device-wrapped-file-key-package");
        string memory submissionTag = "KEY_REWRAP";
        uint8 status = 1;

        TeeMachineResultRegistryMock machineRegistry = new TeeMachineResultRegistryMock();
        machineRegistry.setMachine(teeId, extensionId);
        PrimeServerInstructionResultSinkMock sink = new PrimeServerInstructionResultSinkMock();
        sink.setInstruction(instructionId, requestId);
        PrimeServerFccResultVerifier verifier = new PrimeServerFccResultVerifier(machineRegistry);
        verifier.configureInstructionSender(IPrimeServerInstructionResultSink(address(sink)));
        verifier.configureTeeMachine(teeId, extensionId);

        bytes32 actionResultHash = keccak256(
            abi.encodePacked(keccak256(resultData), instructionId, keccak256(bytes(submissionTag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(verifier.TEE_ACTION_RESULT_PREFIX(), block.chainid, actionResultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(address(0xBEEF));
        verifier.submitResult(requestId, resultData, instructionId, submissionTag, status, signature);

        require(sink.recordedRequestId() == requestId, "request id was not relayed");
        require(sink.recordedResponseCommitment() == sha256(resultData), "result commitment was not relayed");
    }

    function testResultForAnotherInstructionCannotBeRelayedToRequest() public {
        uint256 teePrivateKey = 0xB0B;
        address teeId = vm.addr(teePrivateKey);
        uint256 extensionId = 65922;
        bytes32 requestId = keccak256("access-request");
        bytes32 instructionId = keccak256("instruction");
        bytes32 otherInstructionId = keccak256("other-instruction");
        bytes memory resultData = bytes("device-wrapped-file-key-package");
        string memory submissionTag = "KEY_REWRAP";
        uint8 status = 1;

        TeeMachineResultRegistryMock machineRegistry = new TeeMachineResultRegistryMock();
        machineRegistry.setMachine(teeId, extensionId);
        PrimeServerInstructionResultSinkMock sink = new PrimeServerInstructionResultSinkMock();
        sink.setInstruction(instructionId, requestId);
        PrimeServerFccResultVerifier verifier = new PrimeServerFccResultVerifier(machineRegistry);
        verifier.configureInstructionSender(IPrimeServerInstructionResultSink(address(sink)));
        verifier.configureTeeMachine(teeId, extensionId);

        bytes32 actionResultHash = keccak256(
            abi.encodePacked(keccak256(resultData), otherInstructionId, keccak256(bytes(submissionTag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(verifier.TEE_ACTION_RESULT_PREFIX(), block.chainid, actionResultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        (bool success,) = address(verifier).call(
            abi.encodeWithSelector(
                verifier.submitResult.selector,
                requestId,
                resultData,
                otherInstructionId,
                submissionTag,
                status,
                signature
            )
        );
        require(!success, "unbound instruction result was accepted");
    }
}
