import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrimeAuthManager } from "../rpc/src/auth.mjs";
import { createCoston2Wallet, createFlareRegistry } from "../rpc/src/flare-registry.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { createPrimeRpcServer } from "../rpc/src/server.mjs";
import { createPrimeServerClient } from "../sdk/src/client.mjs";
import { startProviderProcesses, stopProviderProcesses } from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main() {
  const config = await loadConfig();
  const rpcUrl = requireConfig(config, "PRIME_SERVER_RPC_URL");
  const registryAddress = requireConfig(config, "PRIME_SERVER_REGISTRY_ADDRESS");
  const deployerPrivateKey = requireConfig(config, "PRIME_SERVER_DEPLOYER_PRIVATE_KEY");
  const authSecret = requireConfig(config, "PRIME_SERVER_AUTH_SECRET");
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

  const bytecode = await publicClient.getBytecode({ address: registryAddress });
  if (!bytecode || bytecode.length <= 2) throw new Error("registry address has no deployed bytecode");

  const runId = `coston2-registered-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const suite = await startProviderProcesses({
    basePort: 7701 + (process.pid % 400),
    dataRoot: path.join(runtimeRoot, "providers"),
    logRoot: path.join(runtimeRoot, "logs")
  });
  const operationalStatePath = path.join(runtimeRoot, "operational-state.json");
  const objectStore = new JsonOperationalStore(operationalStatePath);
  const authManager = new PrimeAuthManager({
    secret: authSecret,
    domain: config.PRIME_SERVER_AUTH_DOMAIN || "api.primeserver"
  });
  let rpc;

  try {
    rpc = await createPrimeRpcServer({
      providers: suite.providers,
      registry,
      objectStore,
      authManager,
      publicBaseUrl: "http://127.0.0.1/prime/v1"
    });
    await new Promise((resolve) => rpc.server.listen(0, "127.0.0.1", resolve));
    const rpcPort = rpc.server.address().port;
    const baseUrl = `http://127.0.0.1:${rpcPort}/prime/v1`;

    const { wallet: deployerWallet } = createCoston2Wallet({
      privateKey: deployerPrivateKey,
      rpcUrl,
      chainId
    });
    let userWalletData;
    while (!userWalletData) {
      try {
        userWalletData = createCoston2Wallet({
          privateKey: `0x${randomBytes(32).toString("hex")}`,
          rpcUrl,
          chainId
        });
      } catch (error) {
        if (!String(error?.message || error).toLowerCase().includes("private key")) throw error;
      }
    }
    const { account: userAccount, wallet: userWallet } = userWalletData;
    const fundingHash = await deployerWallet.sendTransaction({
      to: userAccount.address,
      value: 1_000_000_000_000_000_000n
    });
    const fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundingHash });

    const client = createPrimeServerClient({
      baseUrl,
      wallet: {
        address: userAccount.address,
        signMessage: ({ message }) => userAccount.signMessage({ message })
      },
      walletClient: userWallet,
      publicClient,
      registryAddress
    });

    const input = Buffer.alloc(256 * 1024);
    for (let index = 0; index < input.length; index += 1) input[index] = (index * 47 + 23) & 0xff;
    const inputHash = sha256(input);
    const blobName = `live/direct-wallet-${runId}.bin`;
    const prepared = await client.prepareBlob(input, {
      name: blobName,
      expirationSeconds: 3600
    });
    const registration = await client.registerBlob(prepared);
    const pendingState = await registry.getBlob(prepared.blobId);
    assertCondition(pendingState?.owner.toLowerCase() === userAccount.address.toLowerCase(), "onchain owner is not the signing wallet");
    assertCondition(pendingState.origin === "user", "onchain registration origin is not user");
    assertCondition(pendingState.status === "pending", "registration did not remain pending before upload");

    const uploaded = await client.uploadRegisteredBlob(prepared, input, { contentType: "application/octet-stream" });
    const activeState = await registry.getBlob(prepared.blobId);
    assertCondition(uploaded.status === "active", "public upload did not finalize as active");
    assertCondition(activeState?.owner.toLowerCase() === userAccount.address.toLowerCase(), "active blob owner changed");
    assertCondition(activeState.origin === "user", "active blob origin changed");

    const downloaded = await client.get(blobName);
    const downloadedBytes = Buffer.from(downloaded.bytes);
    const downloadedHash = sha256(downloadedBytes);
    assertCondition(downloadedHash === inputHash, `downloaded hash mismatch: ${downloadedHash}`);
    const range = await client.get(blobName, { range: "bytes=0-1023" });
    assertCondition(range.status === 206, `range read returned ${range.status}`);
    assertCondition(Buffer.from(range.bytes).equals(input.subarray(0, 1024)), "range bytes do not match input");

    const evidence = {
      runId,
      chainId: actualChainId,
      registry: {
        address: registryAddress,
        deploymentBlock: config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK || null,
        deploymentTransaction: config.PRIME_SERVER_REGISTRY_DEPLOYMENT_TX_HASH || null,
        bytecodeBytes: Math.floor((bytecode.length - 2) / 2)
      },
      rpc: {
        baseUrl,
        publicApi: true,
        sdk: "@prime-server/sdk"
      },
      funding: {
        user: userAccount.address,
        amount: "1 C2FLR",
        transaction: fundingHash,
        blockNumber: fundingReceipt.blockNumber?.toString() || null,
        status: fundingReceipt.status
      },
      registration: {
        blobId: prepared.blobId,
        name: prepared.name,
        owner: pendingState.owner,
        origin: pendingState.origin,
        statusBeforeUpload: pendingState.status,
        transaction: registration.hash,
        blockNumber: registration.receipt?.blockNumber?.toString() || null,
        receiptStatus: registration.receipt?.status || null,
        commitment: prepared.commitment,
        size: prepared.size,
        expiresAt: prepared.expiresAt
      },
      upload: {
        status: uploaded.status,
        statusOnchainAfterUpload: activeState.status,
        acknowledgementCount: activeState.acknowledgementCount,
        providerReceipts: uploaded.providers || []
      },
      read: {
        downloadedStatus: downloaded.status,
        downloadedBytes: downloadedBytes.length,
        inputSha256: inputHash,
        downloadedSha256: downloadedHash,
        matchesInput: downloadedHash === inputHash,
        rangeStatus: range.status,
        rangeBytes: range.bytes.length,
        rangeMatchesInput: Buffer.from(range.bytes).equals(input.subarray(0, 1024))
      }
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_registered_demo_complete",
      evidencePath,
      registryAddress,
      runId,
      user: userAccount.address,
      blobId: prepared.blobId,
      registrationTransaction: registration.hash,
      inputSha256: inputHash,
      downloadedSha256: downloadedHash,
      rangeStatus: range.status,
      finalStatus: activeState.status
    }, null, 2));
  } finally {
    await closeServer(rpc?.server);
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
