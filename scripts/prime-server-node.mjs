import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFlareRegistry } from "../rpc/src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../rpc/src/event-indexer.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { PrimeServerRecoveryCoordinator } from "../rpc/src/recovery-coordinator.mjs";
import { createPrimeRpcServer, rebuildBlob } from "../rpc/src/server.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerServerPath = path.join(repositoryRoot, "provider", "src", "server.mjs");
const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];

function parseDotEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) return ["", ""];
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
        return [key, value];
      })
      .filter(([key]) => key)
  );
}

async function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = parseDotEnv(await readFile(path.join(repositoryRoot, ".env"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...fileConfig, ...process.env };
}

function requireConfig(config, name) {
  if (!config[name]) throw new Error(`${name} is required in .env or the process environment`);
  return config[name];
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`provider did not become healthy at ${url}: ${lastError?.message || "timeout"}`);
}

function startProvider({ providerId, port, dataDir }) {
  const child = spawn(process.execPath, [providerServerPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PRIME_SERVER_PROVIDER_ID: providerId,
      PRIME_SERVER_PROVIDER_PORT: String(port),
      PRIME_SERVER_PROVIDER_HOST: "127.0.0.1",
      PRIME_SERVER_PROVIDER_DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const forward = (stream, label) => {
    stream.on("data", (chunk) => {
      process.stdout.write(`[${label}] ${chunk.toString()}`);
    });
  };
  forward(child.stdout, providerId);
  forward(child.stderr, `${providerId}:stderr`);

  return {
    providerId,
    port,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    child
  };
}

async function stopProviders(providers) {
  await Promise.all(providers.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const finish = () => {
        child.off("exit", finish);
        resolve();
      };
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
  }));
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const config = await loadConfig();
  const rpcUrl = requireConfig(config, "PRIME_SERVER_RPC_URL");
  const registryAddress = requireConfig(config, "PRIME_SERVER_REGISTRY_ADDRESS");
  const deployerPrivateKey = requireConfig(config, "PRIME_SERVER_DEPLOYER_PRIVATE_KEY");
  const providerPrivateKeys = Object.fromEntries(providerIds.map((providerId, index) => [
    providerId,
    requireConfig(config, `PRIME_SERVER_PROVIDER_${index + 1}_PRIVATE_KEY`)
  ]));
  const chainId = Number(config.PRIME_SERVER_CHAIN_ID || 114);
  const rpcHost = config.PRIME_SERVER_RPC_HOST || "0.0.0.0";
  const rpcPort = Number(config.PRIME_SERVER_RPC_PORT || 8080);
  const providerBasePort = Number(config.PRIME_SERVER_PROVIDER_BASE_PORT || 7101);
  const dataRoot = path.resolve(config.PRIME_SERVER_DATA_ROOT || path.join(repositoryRoot, ".prime-server", "runtime", "providers"));
  const operationalStatePath = path.resolve(
    config.PRIME_SERVER_OPERATIONAL_STATE_PATH || path.join(repositoryRoot, ".prime-server", "runtime", "operational-state.json")
  );
  const pollIntervalMs = Number(config.PRIME_SERVER_EVENT_POLL_INTERVAL_MS || 15_000);

  if (chainId !== 114) throw new Error(`expected Coston2 chain ID 114, got ${chainId}`);
  if (!Number.isSafeInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535) throw new Error("invalid Prime RPC port");
  if (!Number.isSafeInteger(providerBasePort) || providerBasePort < 1 || providerBasePort > 65531) throw new Error("invalid provider base port");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000) throw new Error("invalid event poll interval");

  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.dirname(operationalStatePath), { recursive: true });

  const providers = [];
  let rpc;
  let stopping = false;
  let pollTimer;

  try {
    for (let index = 0; index < providerIds.length; index += 1) {
      const providerId = providerIds[index];
      const provider = startProvider({
        providerId,
        port: providerBasePort + index,
        dataDir: path.join(dataRoot, providerId)
      });
      providers.push(provider);
      await waitForHealth(provider.url);
    }

    const registry = createFlareRegistry({
      address: registryAddress,
      rpcUrl,
      chainId,
      deployerPrivateKey,
      providerPrivateKeys
    });
    const actualChainId = await registry.publicClient.getChainId();
    if (actualChainId !== chainId) throw new Error(`RPC chain ID mismatch: expected ${chainId}, got ${actualChainId}`);
    const bytecode = await registry.publicClient.getBytecode({ address: registryAddress });
    if (!bytecode || bytecode.length <= 2) throw new Error("registry address has no deployed bytecode");

    const operationalStore = new JsonOperationalStore(operationalStatePath);
    const deploymentBlock = config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK
      ? BigInt(config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK)
      : null;
    const fromBlock = deploymentBlock === null
      ? await registry.publicClient.getBlockNumber()
      : deploymentBlock + 1n;
    const indexer = new PrimeServerEventIndexer({
      publicClient: registry.publicClient,
      address: registryAddress,
      fromBlock,
      stateStore: operationalStore
    });
    const recoveryCoordinator = new PrimeServerRecoveryCoordinator({
      store: operationalStore,
      workerId: `prime-server-node-${process.pid}`,
      recover: async (blobId) => rebuildBlob({
        blobId,
        providers,
        registry,
        erasureEngine: rpc.erasureEngine
      })
    });

    rpc = await createPrimeRpcServer({ providers, registry, recoveryCoordinator });
    await new Promise((resolve) => rpc.server.listen(rpcPort, rpcHost, resolve));

    const pollEvents = async () => {
      try {
        const events = await indexer.poll();
        if (events.length > 0) {
          console.log(JSON.stringify({ event: "flare_events_indexed", count: events.length, nextBlock: indexer.nextBlock.toString() }));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "flare_event_indexer_error", error: error instanceof Error ? error.message : String(error) }));
      }
    };
    await pollEvents();
    pollTimer = setInterval(pollEvents, pollIntervalMs);
    pollTimer.unref?.();

    console.log(JSON.stringify({
      event: "prime_server_started",
      chainId: actualChainId,
      registryAddress,
      rpcHost,
      rpcPort,
      providerCount: providers.length,
      dataRoot,
      operationalStatePath,
      bytecodeBytes: Math.floor((bytecode.length - 2) / 2)
    }));

    await new Promise((resolve) => {
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    await closeServer(rpc?.server);
    await stopProviders(providers);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
