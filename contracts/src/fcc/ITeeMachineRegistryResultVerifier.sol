// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only FCC machine surface used by the result verifier.
/// @dev The methods mirror Flare's deployed MachineManager diamond interface.
interface ITeeMachineRegistryResultVerifier {
    struct TeeMachine {
        address teeId;
        address teeProxyId;
        string url;
    }

    function getTeeMachine(address teeId) external view returns (TeeMachine memory);

    function getExtensionId(address teeId) external view returns (uint256);
}
