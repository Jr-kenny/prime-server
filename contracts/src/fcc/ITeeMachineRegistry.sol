// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal FCC machine registry surface used by the Prime Server instruction sender.
/// @dev Keep this interface aligned with Flare's published FCC interface when the package is available.
interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 extensionId, uint256 count) external view returns (address[] memory teeIds);
}
