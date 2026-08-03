import { VERSION } from "./config.js";
import { register, reportState } from "./handlers.js";
import { Server } from "../../../fce-extension-scaffold/typescript/src/base/server.js";

async function main(): Promise<void> {
  const extPort = process.env.EXTENSION_PORT ?? "7702";
  const signPort = process.env.SIGN_PORT ?? "7701";
  const server = new Server(extPort, signPort, VERSION, register, reportState);
  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await server.listenAndServe();
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
