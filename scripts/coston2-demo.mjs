import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFlareRegistry } from "../rpc/src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../rpc/src/event-indexer.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { PrimeServerRecoveryCoordinator } from "../rpc/src/recovery-coordinator.mjs";
import { createPrimeRpcServer, rebuildBlob } from "../rpc/src/server.mjs";
import {
  startProviderProcess,
  startProviderProcesses,
  stopProviderProcesses,
} from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];
const inputSize = 2 * 1024 * 1024;

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
  const fileConfig = parseDotEnv(await readFile(path.join(repositoryRoot, ".env"), "utf8"));
  return { ...fileConfig, ...process.env };
}

function requireConfig(config, name) {
  if (!config[name]) throw new Error(`${name} is required in .env`);
  return config[name];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function preserveLostShard(provider, blobId, shardIndex) {
  const moved = [];
  for (const suffix of [".shard", ".json"]) {
    const source = path.join(provider.dataDir, `${blobId}.${shardIndex}${suffix}`);
    const destination = `${source}.lost`;
    await rename(source, destination);
    moved.push(destination);
  }
  return moved;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${options?.method || "GET"} ${url} returned ${response.status}: ${body.error || "request failed"}`);
  return { response, body };
}

function journalSlice(registry, start) {
  return registry.transactionJournal().slice(start).map((entry) => ({
    functionName: entry.functionName,
    hash: entry.hash,
    blockNumber: entry.blockNumber,
    status: entry.status
  }));
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
  if (chainId !== 114) throw new Error(`expected Coston2 chain ID 114, got ${chainId}`);

  const registry = createFlareRegistry({
    address: registryAddress,
    rpcUrl,
    chainId,
    deployerPrivateKey,
    providerPrivateKeys
  });
  const publicClient = registry.publicClient;
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) throw new Error(`RPC chain ID mismatch: expected ${chainId}, got ${actualChainId}`);

  const deploymentBlock = config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK
    ? BigInt(config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK)
    : null;
  const runStartBlock = await publicClient.getBlockNumber();
  const runId = `coston2-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const suite = await startProviderProcesses({
    basePort: 7301 + (process.pid % 400),
    dataRoot: path.join(runtimeRoot, "providers"),
    logRoot: path.join(runtimeRoot, "logs")
  });
  const operationalStatePath = path.join(runtimeRoot, "operational-state.json");
  const operationalStore = new JsonOperationalStore(operationalStatePath);
  let rpc;
  const recoveryCoordinator = new PrimeServerRecoveryCoordinator({
    store: operationalStore,
    workerId: `coston2-demo-${process.pid}`,
    recover: async (blobId) => rebuildBlob({
      blobId,
      providers: suite.providers,
      registry,
      erasureEngine: rpc.erasureEngine
    })
  });

  try {
    const bytecode = await publicClient.getBytecode({ address: registryAddress });
    if (!bytecode || bytecode.length <= 2) throw new Error("registry address has no deployed bytecode");

    const indexer = new PrimeServerEventIndexer({
      publicClient,
      address: registryAddress,
      fromBlock: runStartBlock + 1n,
      stateStore: operationalStore
    });
    rpc = await createPrimeRpcServer({ providers: suite.providers, registry, recoveryCoordinator });
    await new Promise((resolve) => rpc.server.listen(0, "127.0.0.1", resolve));
    const rpcPort = rpc.server.address().port;
    const rpcBaseUrl = `http://127.0.0.1:${rpcPort}`;

    const input = Buffer.alloc(inputSize);
    for (let index = 0; index < input.length; index += 1) input[index] = (index * 31 + 17) & 0xff;
    const inputHash = sha256(input);
    const registrationJournalLength = registry.transactionJournal().length;

    const uploadResponse = await fetch(`${rpcBaseUrl}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: input
    });
    const upload = await uploadResponse.json();
    if (!uploadResponse.ok) throw new Error(`upload returned ${uploadResponse.status}: ${upload.error || "upload failed"}`);
    const uploadJournal = journalSlice(registry, registrationJournalLength);
    const blobStateAfterUpload = await registry.getBlob(upload.blobId);

    const failedProviders = [suite.providers[1], suite.providers[3]];
    const failureStartedAt = new Date().toISOString();
    await stopProviderProcesses({ providers: failedProviders });

    const recoveredResponse = await fetch(`${rpcBaseUrl}/v1/blobs/${upload.blobId}/content`);
    const recoveredBytes = Buffer.from(await recoveredResponse.arrayBuffer());
    if (!recoveredResponse.ok) throw new Error(`recovery read returned ${recoveredResponse.status}`);
    const recoveredHash = sha256(recoveredBytes);
    if (recoveredHash !== inputHash) throw new Error(`recovered hash mismatch: ${recoveredHash}`);

    const lostShardFiles = [];
    for (const shardIndex of [1, 3]) {
      lostShardFiles.push(...await preserveLostShard(suite.providers[shardIndex], upload.blobId, shardIndex));
    }
    for (const shardIndex of [1, 3]) {
      const oldProvider = suite.providers[shardIndex];
      suite.providers[shardIndex] = await startProviderProcess({
        providerId: oldProvider.providerId,
        port: oldProvider.port,
        dataDir: oldProvider.dataDir,
        logPath: oldProvider.logPath
      });
    }

    const rebuildJournalLength = registry.transactionJournal().length;
    const rebuild = await requestJson(`${rpcBaseUrl}/v1/blobs/${upload.blobId}/recover`, { method: "POST" });
    const rebuildJournal = journalSlice(registry, rebuildJournalLength);
    const finalResponse = await fetch(`${rpcBaseUrl}/v1/blobs/${upload.blobId}/content`);
    const finalBytes = Buffer.from(await finalResponse.arrayBuffer());
    if (!finalResponse.ok) throw new Error(`final read returned ${finalResponse.status}`);
    const finalHash = sha256(finalBytes);
    if (finalHash !== inputHash) throw new Error(`final hash mismatch: ${finalHash}`);

    const indexedEvents = await indexer.poll();
    const eventCounts = Object.fromEntries(
      [...new Set(indexedEvents.map((event) => event.eventName))].map((eventName) => [
        eventName,
        indexedEvents.filter((event) => event.eventName === eventName).length
      ])
    );
    const finalBlobState = await registry.getBlob(upload.blobId);
    const evidence = {
      runId,
      chainId: actualChainId,
      rpcConfigured: Boolean(rpcUrl),
      wssConfigured: Boolean(config.PRIME_SERVER_WSS_URL),
      registry: {
        address: registryAddress,
        deploymentBlock: deploymentBlock?.toString() || null,
        bytecodeBytes: Math.floor((bytecode.length - 2) / 2)
      },
      deployer: registry.deployer,
      providers: suite.providers.map((provider) => ({
        providerId: provider.providerId,
        endpoint: provider.url,
        dataDir: provider.dataDir,
        logPath: provider.logPath,
        operator: registry.providerOperators()[provider.providerId]
      })),
      input: {
        bytes: input.length,
        sha256: inputHash
      },
      blob: {
        blobId: upload.blobId,
        commitment: upload.commitment,
        chunkCommitments: upload.chunkCommitments,
        statusAfterUpload: blobStateAfterUpload.status,
        statusAfterRebuild: finalBlobState.status,
        acknowledgementCountAfterUpload: blobStateAfterUpload.acknowledgementCount
      },
      upload: {
        providerReceipts: upload.providers,
        transactions: uploadJournal
      },
      failure: {
        failedProviderIds: failedProviders.map((provider) => provider.providerId),
        startedAt: failureStartedAt,
        recovered: recoveredResponse.headers.get("x-prime-recovered"),
        missingShards: recoveredResponse.headers.get("x-prime-missing-shards"),
        recoveredSha256: recoveredHash
      },
      rebuild: {
        result: rebuild.body,
        lostShardFiles,
        transactions: rebuildJournal
      },
      operationalState: {
        path: operationalStatePath,
        cursor: await operationalStore.getCursor(registryAddress),
        recoveryJobs: await recoveryCoordinator.listJobs()
      },
      final: {
        sha256: finalHash,
        byteLength: finalBytes.length,
        matchesInput: finalHash === inputHash
      },
      events: {
        fromBlock: (runStartBlock + 1n).toString(),
        nextBlock: indexer.nextBlock.toString(),
        counts: eventCounts,
        snapshot: indexer.snapshot()
      }
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_demo_complete",
      evidencePath,
      registryAddress,
      runId,
      blobId: upload.blobId,
      inputSha256: inputHash,
      recoveredSha256: recoveredHash,
      finalSha256: finalHash,
      finalStatus: finalBlobState.status,
      failedProviders: failedProviders.map((provider) => provider.providerId),
      eventCounts,
      uploadTransactions: uploadJournal.map(({ functionName, hash, blockNumber }) => ({ functionName, hash, blockNumber })),
      rebuildTransactions: rebuildJournal.map(({ functionName, hash, blockNumber }) => ({ functionName, hash, blockNumber }))
    }, null, 2));
  } finally {
    await closeServer(rpc?.server);
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
