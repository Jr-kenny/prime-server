// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal FCC registry surface used by the Prime Server instruction sender.
/// @dev Keep this interface aligned with Flare's published FCC interface when the package is available.
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(address[] calldata teeIds, TeeInstructionParams calldata instructionParams)
        external
        payable
        returns (bytes32 instructionId);

    function nextPublicExtensionId() external view returns (uint256);

    function getTeeExtensionInstructionsSender(uint256 extensionId) external view returns (address);
}
