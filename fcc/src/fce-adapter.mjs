import {
  OP_COMMAND_CONFIDENTIAL_COMPUTE,
  OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME,
  OP_COMMAND_KEY_REWRAP,
  OP_COMMAND_KEY_REWRAP_NAME,
  OP_TYPE_PRIME_SERVER,
  OP_TYPE_PRIME_SERVER_NAME
} from "./config.mjs";
import { handleAction } from "./handler.mjs";

/// @notice Adapter for the official Flare FCE TypeScript framework.
/// @dev The framework supplies a hex originalMessage to each handler. The TEE key and secure
///      ciphertext retriever are injected by the deployment-specific extension process.
export function register(framework, { teePrivateKey, retrieveCiphertext } = {}) {
  if (!framework || typeof framework.handle !== "function") throw new Error("FCE framework is required");

  framework.handle(OP_TYPE_PRIME_SERVER_NAME, OP_COMMAND_KEY_REWRAP_NAME, (message) => handleAction({
    opType: OP_TYPE_PRIME_SERVER,
    opCommand: OP_COMMAND_KEY_REWRAP,
    message,
    teePrivateKey
  }));
  framework.handle(OP_TYPE_PRIME_SERVER_NAME, OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME, (message) => handleAction({
    opType: OP_TYPE_PRIME_SERVER,
    opCommand: OP_COMMAND_CONFIDENTIAL_COMPUTE,
    message,
    teePrivateKey,
    retrieveCiphertext
  }));
}
