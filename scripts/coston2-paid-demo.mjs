import { createECDH, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrimeAuthManager } from "../rpc/src/auth.mjs";
import { createFlareRegistry, createCoston2Wallet } from "../rpc/src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../rpc/src/event-indexer.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { createPrimeRpcServer } from "../rpc/src/server.mjs";
import { decryptBlob } from "../sdk/src/encryption.mjs";
import { createPrimeServerClient } from "../sdk/src/client.mjs";
import { startProviderProcesses, stopProviderProcesses } from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];

function parseDotEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) return ["", ""];
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
  }).filter(([key]) => key));
}

async function loadConfig() {
  return parseDotEnv(await readFile(path.join(repositoryRoot, ".env"), "utf8"));
}

function required(config, name) {
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

async function main() {
  const config = await loadConfig();
  const rpcUrl = required(config, "PRIME_SERVER_RPC_URL");
  const registryAddress = required(config, "PRIME_SERVER_REGISTRY_ADDRESS");
  const deployerPrivateKey = required(config, "PRIME_SERVER_DEPLOYER_PRIVATE_KEY");
  const authSecret = required(config, "PRIME_SERVER_AUTH_SECRET");
  const chainId = Number(config.PRIME_SERVER_CHAIN_ID || 114);
  if (chainId !== 114) throw new Error(`expected Coston2 chain ID 114, got ${chainId}`);
  const providerPrivateKeys = Object.fromEntries(providerIds.map((providerId, index) => [
    providerId,
    required(config, `PRIME_SERVER_PROVIDER_${index + 1}_PRIVATE_KEY`)
  ]));

  const registry = createFlareRegistry({ address: registryAddress, rpcUrl, chainId, deployerPrivateKey, providerPrivateKeys });
  const publicClient = registry.publicClient;
  const bytecode = await publicClient.getBytecode({ address: registryAddress });
  if (!bytecode || bytecode.length <= 2) throw new Error("registry address has no deployed bytecode");
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) throw new Error(`RPC chain ID mismatch: expected ${chainId}, got ${actualChainId}`);

  const runId = `coston2-paid-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const suite = await startProviderProcesses({
    basePort: 7901 + (process.pid % 300),
    dataRoot: path.join(runtimeRoot, "providers"),
    logRoot: path.join(runtimeRoot, "logs")
  });
  const objectStore = new JsonOperationalStore(path.join(runtimeRoot, "objects.json"));
  const authManager = new PrimeAuthManager({ secret: authSecret, domain: config.PRIME_SERVER_AUTH_DOMAIN || "api.primeserver" });
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
    const baseUrl = `http://127.0.0.1:${rpc.server.address().port}/prime/v1`;
    const indexer = new PrimeServerEventIndexer({
      publicClient,
      address: registryAddress,
      fromBlock: await publicClient.getBlockNumber() + 1n
    });

    const { account: userAccount, wallet: userWallet } = createCoston2Wallet({
      privateKey: `0x${createHash("sha256").update(`${runId}:user`).digest("hex")}`,
      rpcUrl,
      chainId
    });
    const { wallet: deployerWallet } = createCoston2Wallet({ privateKey: deployerPrivateKey, rpcUrl, chainId });
    const fundingHash = await deployerWallet.sendTransaction({ to: userAccount.address, value: 1_000_000_000_000_000_000n });
    const fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundingHash });
    const client = createPrimeServerClient({
      baseUrl,
      wallet: {
        address: userAccount.address,
        signMessage: ({ message }) => userAccount.signMessage({ message })
      },
      walletClient: userWallet,
      publicClient,
      registryAddress,
      chainId
    });

    const publicInput = Buffer.alloc(256 * 1024);
    for (let index = 0; index < publicInput.length; index += 1) publicInput[index] = (index * 37 + 19) & 0xff;
    const publicPrepared = await client.prepareBlob(publicInput, {
      name: `paid/public-${runId}.bin`,
      expirationSeconds: 3600
    });
    const publicRegistration = await client.registerPaidBlob(publicPrepared, {
      storageMode: "public",
      accessPolicy: "owner_only"
    });
    const publicUpload = await client.uploadRegisteredBlob(publicPrepared, publicInput);
    const publicState = await registry.getBlob(publicPrepared.blobId);
    const publicPayment = await registry.getBlobPayment(publicPrepared.blobId);
    const publicRead = await client.get(publicPrepared.name);
    const publicHash = sha256(publicRead.bytes);

    const teeKey = createECDH("secp256k1");
    teeKey.generateKeys();
    const privateInput = Buffer.from(`private ciphertext proof ${runId}`);
    const privatePrepared = await client.prepareEncryptedBlob(privateInput, {
      name: `opaque/private-${runId}.bin`,
      storageMode: "private",
      accessPolicy: "owner_only",
      fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
      expirationSeconds: 3600
    });
    const privateRegistration = await client.registerPaidBlob(privatePrepared);
    const privateUpload = await client.uploadRegisteredBlob(privatePrepared, privatePrepared.ciphertext);
    const privateState = await registry.getBlob(privatePrepared.blobId);
    const privatePayment = await registry.getBlobPayment(privatePrepared.blobId);
    const privateRead = await client.get(privatePrepared.name);
    const privatePlaintext = await decryptBlob(privateRead.bytes, privatePrepared.fileKey);

    const device = client.createDeviceKeyPair();
    const access = await client.authorizeConfidentialAccess({
      blobId: privatePrepared.blobId,
      devicePublicKey: device.publicKey,
      purpose: "view"
    });
    const accessState = await registry.getConfidentialAccessRequest(access.requestId);
    const accessUsable = await registry.isConfidentialAccessUsable(access.requestId);
    const events = await indexer.poll();
    const eventCounts = Object.fromEntries([...new Set(events.map((event) => event.eventName))].map((eventName) => [
      eventName,
      events.filter((event) => event.eventName === eventName).length
    ]));
    const evidence = {
      runId,
      chainId: actualChainId,
      registry: {
        address: registryAddress,
        deploymentBlock: config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK || null,
        deploymentTransaction: config.PRIME_SERVER_REGISTRY_DEPLOYMENT_TX_HASH || null,
        bytecodeBytes: Math.floor((bytecode.length - 2) / 2)
      },
      funding: {
        user: userAccount.address,
        amountWei: "1000000000000000000",
        transaction: fundingHash,
        blockNumber: fundingReceipt.blockNumber?.toString() || null,
        status: fundingReceipt.status
      },
      publicPaid: {
        blobId: publicPrepared.blobId,
        name: publicPrepared.name,
        registrationTransaction: publicRegistration.hash,
        commitment: publicPrepared.commitment,
        quote: Object.fromEntries(Object.entries(publicRegistration.quote).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
        uploadStatus: publicUpload.status,
        onchainStatus: publicState.status,
        paymentStatus: publicPayment.statusName,
        providerSettlements: publicUpload.providerSettlements,
        inputSha256: sha256(publicInput),
        downloadedSha256: publicHash,
        matchesInput: publicHash === sha256(publicInput),
        rangeStatus: (await client.get(publicPrepared.name, { range: "bytes=0-1023" })).status
      },
      privatePaid: {
        blobId: privatePrepared.blobId,
        name: privatePrepared.name,
        registrationTransaction: privateRegistration.hash,
        ciphertextCommitment: privatePrepared.commitment,
        ciphertextBytes: privatePrepared.size,
        originalBytes: privatePrepared.originalSize,
        onchainStorageMode: privateState.policy.storageModeName,
        uploadStatus: privateUpload.status,
        paymentStatus: privatePayment.statusName,
        providerSettlements: privateUpload.providerSettlements,
        plaintextSha256: sha256(privateInput),
        decryptedSha256: sha256(privatePlaintext),
        decryptsLocally: privatePlaintext.equals(privateInput),
        fccEnvelopeCommitment: privatePrepared.keyEnvelopeCommitment,
        fccLiveRelease: false
      },
      confidentialAccess: {
        requestId: access.requestId,
        transaction: access.hash,
        requester: accessState.requester,
        deviceKeyCommitment: accessState.deviceKeyCommitment,
        nonce: accessState.nonce.toString(),
        purpose: accessState.purpose,
        usableOnchain: accessUsable,
        consumedByFcc: accessState.consumed,
        attestationVerified: false
      },
      events: {
        counts: eventCounts,
        nextBlock: indexer.nextBlock.toString()
      }
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_paid_demo_complete",
      evidencePath,
      registryAddress,
      runId,
      user: userAccount.address,
      publicBlobId: publicPrepared.blobId,
      publicPaymentStatus: publicPayment.statusName,
      privateBlobId: privatePrepared.blobId,
      privatePaymentStatus: privatePayment.statusName,
      localPrivateDecrypt: privatePlaintext.equals(privateInput),
      accessRequestId: access.requestId,
      accessUsableOnchain: accessUsable,
      fccLiveRelease: false
    }, null, 2));
  } finally {
    await closeServer(rpc?.server);
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
