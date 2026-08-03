// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITeeMachineRegistryResultVerifier} from "./ITeeMachineRegistryResultVerifier.sol";

interface IPrimeServerInstructionResultSink {
    function requestIdByInstructionId(bytes32 instructionId) external view returns (bytes32 requestId);

    function recordAccessResult(bytes32 requestId, bytes32 responseCommitment) external;
}

/// @title Prime Server FCC Result Verifier
/// @notice Verifies the official Flare TEE ActionResult signature before it
///         consumes a Prime Server confidential access request.
/// @dev The owner can configure the sender and registered machine once. The
///      result path itself has no owner bypass. Any caller may relay a result
///      after the registered TEE signature and instruction binding pass.
contract PrimeServerFccResultVerifier {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    address public immutable owner;
    ITeeMachineRegistryResultVerifier public immutable teeMachineRegistry;
    IPrimeServerInstructionResultSink public instructionSender;
    address public teeId;
    uint256 public extensionId;

    event InstructionSenderConfigured(address indexed instructionSender);
    event TeeMachineConfigured(address indexed teeId, uint256 indexed extensionId);
    event ResultVerified(
        bytes32 indexed requestId,
        bytes32 indexed instructionId,
        address indexed teeId,
        bytes32 responseCommitment
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not verifier owner");
        _;
    }

    constructor(ITeeMachineRegistryResultVerifier teeMachineRegistry_) {
        require(address(teeMachineRegistry_) != address(0), "machine registry is zero");
        require(address(teeMachineRegistry_).code.length > 0, "machine registry has no code");
        owner = msg.sender;
        teeMachineRegistry = teeMachineRegistry_;
    }

    /// @notice Connects the already-deployed Prime Server instruction sender once.
    function configureInstructionSender(IPrimeServerInstructionResultSink instructionSender_) external onlyOwner {
        require(address(instructionSender) == address(0), "instruction sender already configured");
        require(address(instructionSender_) != address(0), "instruction sender is zero");
        require(address(instructionSender_).code.length > 0, "instruction sender has no code");
        instructionSender = instructionSender_;
        emit InstructionSenderConfigured(address(instructionSender_));
    }

    /// @notice Connects one registered FCC machine to this result path once.
    function configureTeeMachine(address teeId_, uint256 extensionId_) external onlyOwner {
        require(teeId == address(0), "TEE machine already configured");
        require(teeId_ != address(0), "TEE machine is zero");
        require(extensionId_ != 0, "extension id is zero");

        ITeeMachineRegistryResultVerifier.TeeMachine memory machine = teeMachineRegistry.getTeeMachine(teeId_);
        require(machine.teeId == teeId_, "TEE machine is not registered");
        require(teeMachineRegistry.getExtensionId(teeId_) == extensionId_, "TEE extension mismatch");

        teeId = teeId_;
        extensionId = extensionId_;
        emit TeeMachineConfigured(teeId_, extensionId_);
    }

    /// @notice Verifies and relays a raw signed FCC ActionResult.
    /// @param requestId Prime Server access intent being consumed.
    /// @param resultData Exact ActionResult.Data bytes returned by the FCC proxy.
    /// @param actionId Exact ActionResult.ID, normally the FCC instruction ID.
    /// @param submissionTag Exact ActionResult.SubmissionTag returned by the proxy.
    /// @param status Exact ActionResult.Status. Only success status 1 is accepted.
    /// @param signature TEE signature returned by the FCC proxy.
    function submitResult(
        bytes32 requestId,
        bytes calldata resultData,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external {
        require(address(instructionSender) != address(0), "instruction sender not configured");
        require(teeId != address(0), "TEE machine not configured");
        require(status == 1, "TEE result was not successful");
        require(instructionSender.requestIdByInstructionId(actionId) == requestId, "instruction request mismatch");

        ITeeMachineRegistryResultVerifier.TeeMachine memory machine = teeMachineRegistry.getTeeMachine(teeId);
        require(machine.teeId == teeId, "TEE machine is no longer registered");
        require(teeMachineRegistry.getExtensionId(teeId) == extensionId, "TEE extension changed");

        bytes32 resultHash = keccak256(
            abi.encodePacked(
                keccak256(resultData),
                actionId,
                keccak256(bytes(submissionTag)),
                status
            )
        );
        bytes32 payloadHash = keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, resultHash));
        address signer = _recover(_ethSigned(payloadHash), signature);
        require(signer == teeId, "bad registered TEE signature");

        bytes32 responseCommitment = sha256(resultData);
        instructionSender.recordAccessResult(requestId, responseCommitment);
        emit ResultVerified(requestId, actionId, teeId, responseCommitment);
    }

    function _ethSigned(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "invalid TEE signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid TEE signature v");
        return ecrecover(digest, v, r, s);
    }
}
