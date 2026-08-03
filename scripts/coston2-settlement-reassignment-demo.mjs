import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrimeAuthManager } from "../rpc/src/auth.mjs";
import { acknowledgementContext } from "../rpc/src/ack-context.mjs";
import { createFlareRegistry, createCoston2Wallet } from "../rpc/src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../rpc/src/event-indexer.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { readBlob, createPrimeRpcServer } from "../rpc/src/server.mjs";
import { createPrimeServerClient } from "../sdk/src/client.mjs";
import { startProviderProcesses, stopProviderProcesses } from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];
const targetShardIndex = 0;
const replacementProviderId = "provider-2";
const expirationSeconds = 240;
const globalMarkerAbi = [{
  type: "function",
  name: "providerSettlementClaimed",
  stateMutability: "view",
  inputs: [
    { name: "blobId", type: "bytes32" },
    { name: "providerId", type: "uint256" },
    { name: "shardIndex", type: "uint8" }
  ],
  outputs: [{ name: "", type: "bool" }]
}, {
  type: "function",
  name: "providerReserveClaimed",
  stateMutability: "view",
  inputs: [
    { name: "blobId", type: "bytes32" },
    { name: "providerId", type: "uint256" },
    { name: "shardIndex", type: "uint8" }
  ],
  outputs: [{ name: "", type: "bool" }]
}];

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

function required(config, name) {
  if (!config[name]) throw new Error(`${name} is required in .env`);
  return config[name];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function journalSlice(registry, start) {
  return registry.transactionJournal().slice(start).map((entry) => ({
    functionName: entry.functionName,
    hash: entry.hash,
    blockNumber: entry.blockNumber,
    status: entry.status
  }));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForExpiry(publicClient, expiresAt) {
  while (true) {
    const block = await publicClient.getBlock();
    if (Number(block.timestamp) > expiresAt) return Number(block.timestamp);
    await delay(5_000);
  }
}

async function uploadRebuiltShard({ provider, blobId, shardIndex, bytes, commitment, context }) {
  const response = await fetch(`${provider.url}/v1/shards/${blobId}/${shardIndex}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-prime-shard-commitment": commitment,
      "x-prime-ack-context": context
    },
    body: bytes
  });
  const receipt = await response.json();
  if (!response.ok) throw new Error(`replacement provider rejected shard: ${receipt.error || response.status}`);
  return receipt;
}

async function readGlobalMarker({ publicClient, registryAddress, functionName, blobId, shardIndex }) {
  return publicClient.readContract({
    address: registryAddress,
    abi: globalMarkerAbi,
    functionName,
    args: [blobId, 0n, shardIndex]
  });
}

async function main() {
  const config = parseDotEnv(await readFile(path.join(repositoryRoot, ".env"), "utf8"));
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

  const runId = `coston2-settlement-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const suite = await startProviderProcesses({
    basePort: 8101 + (process.pid % 200),
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

    const userPrivateKey = `0x${sha256(Buffer.from(`${runId}:user`))}`;
    const { account: userAccount, wallet: userWallet } = createCoston2Wallet({
      privateKey: userPrivateKey,
      rpcUrl,
      chainId
    });
    const { wallet: deployerWallet } = createCoston2Wallet({ privateKey: deployerPrivateKey, rpcUrl, chainId });
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
      registryAddress,
      chainId
    });

    const input = Buffer.alloc(256 * 1024);
    for (let index = 0; index < input.length; index += 1) input[index] = (index * 41 + 23) & 0xff;
    const prepared = await client.prepareBlob(input, {
      name: `paid/reassignment-${runId}.bin`,
      expirationSeconds
    });
    const registration = await client.registerPaidBlob(prepared, {
      storageMode: "public",
      accessPolicy: "owner_only"
    });
    const uploadJournalLength = registry.transactionJournal().length;
    const upload = await client.uploadRegisteredBlob(prepared, input);
    const uploadTransactions = journalSlice(registry, uploadJournalLength);
    const afterUpload = await registry.getBlob(prepared.blobId);
    const paymentAfterUpload = await registry.getBlobPayment(prepared.blobId);
    const providerRewardPerShard = paymentAfterUpload.providerRewardPerShard;
    const reservePerShard = paymentAfterUpload.providerPool / BigInt(afterUpload.totalShards) - providerRewardPerShard;
    const immediateSettled = providerRewardPerShard * BigInt(afterUpload.totalShards);
    if (paymentAfterUpload.providerSettled !== immediateSettled) {
      throw new Error(`expected immediate settlement ${immediateSettled}, got ${paymentAfterUpload.providerSettled}`);
    }
    if (paymentAfterUpload.statusName !== "partially_settled") {
      throw new Error(`expected partially settled payment, got ${paymentAfterUpload.statusName}`);
    }
    if (Math.floor(Date.now() / 1000) >= prepared.expiresAt) throw new Error("paid blob expired before recovery test");

    const originalProviderId = afterUpload.placement[targetShardIndex];
    if (originalProviderId === replacementProviderId) throw new Error("replacement provider must have a different ID");
    const originalProvider = suite.providers.find((provider) => provider.providerId === originalProviderId);
    const replacementProvider = suite.providers.find((provider) => provider.providerId === replacementProviderId);
    if (!originalProvider || !replacementProvider) throw new Error("provider placement is missing from the live suite");

    await stopProviderProcesses({ providers: [originalProvider] });
    const normalizedBlobId = prepared.blobId.replace(/^0x/, "");
    const recovered = await readBlob({
      blobId: normalizedBlobId,
      providers: suite.providers,
      registry,
      erasureEngine: rpc.erasureEngine
    });
    if (!recovered.missingShards.includes(targetShardIndex)) throw new Error("failed provider shard was not detected");
    if (recovered.contentHash !== sha256(input)) throw new Error("recovered content hash mismatch");

    const recoveryJournalLength = registry.transactionJournal().length;
    await registry.startRecovery(prepared.blobId, targetShardIndex);
    await registry.reassignShard(prepared.blobId, targetShardIndex, replacementProviderId);
    const rebuiltBytes = Buffer.from(recovered.recoveredShards[targetShardIndex]);
    const rebuiltCommitment = sha256(rebuiltBytes);
    const ackContext = acknowledgementContext({
      chainId,
      registryAddress,
      blobId: prepared.blobId,
      owner: afterUpload.owner,
      nameHash: afterUpload.nameHash,
      providerId: replacementProviderId,
      shardIndex: targetShardIndex,
      commitment: rebuiltCommitment,
      size: rebuiltBytes.length
    });
    const replacementReceipt = await uploadRebuiltShard({
      provider: replacementProvider,
      blobId: normalizedBlobId,
      shardIndex: targetShardIndex,
      bytes: rebuiltBytes,
      commitment: rebuiltCommitment,
      context: ackContext
    });
    await registry.acknowledgeShard({
      blobId: prepared.blobId,
      shardIndex: targetShardIndex,
      providerId: replacementProviderId,
      commitment: replacementReceipt.commitment,
      size: replacementReceipt.size,
      ackContext,
      signedPayload: replacementReceipt.signedPayload,
      signature: replacementReceipt.signature
    });
    await registry.recordRebuiltShard({
      blobId: prepared.blobId,
      shardIndex: targetShardIndex,
      providerId: replacementProviderId,
      commitment: replacementReceipt.commitment
    });
    const recoveryTransactions = journalSlice(registry, recoveryJournalLength);

    const recoveredRead = await client.get(prepared.name);
    const recoveredReadHash = sha256(recoveredRead.bytes);
    if (recoveredReadHash !== sha256(input)) throw new Error("developer API recovery read hash mismatch");

    const expiryBlockTimestamp = await waitForExpiry(publicClient, prepared.expiresAt);
    const paymentBeforeReserve = await registry.getBlobPayment(prepared.blobId);
    const replacementClaimJournalLength = registry.transactionJournal().length;
    const replacementShardClaim = await registry.claimProviderSettlement({
      blobId: prepared.blobId,
      providerId: replacementProviderId,
      shardIndices: [targetShardIndex]
    });
    const paymentAfterReplacementShard = await registry.getBlobPayment(prepared.blobId);
    const replacementShardReserve = paymentAfterReplacementShard.providerSettled - paymentBeforeReserve.providerSettled;
    if (replacementShardReserve !== reservePerShard) {
      throw new Error(`replacement shard received ${replacementShardReserve}, expected reserve ${reservePerShard}`);
    }

    const originalReplacementProviderShard = 1;
    const replacementOriginalShardClaim = await registry.claimProviderSettlement({
      blobId: prepared.blobId,
      providerId: replacementProviderId,
      shardIndices: [originalReplacementProviderShard]
    });
    const providerThreeClaim = await registry.claimProviderSettlement({
      blobId: prepared.blobId,
      providerId: "provider-3",
      shardIndices: [2]
    });
    const providerFourClaim = await registry.claimProviderSettlement({
      blobId: prepared.blobId,
      providerId: "provider-4",
      shardIndices: [3]
    });
    const settlementTransactions = journalSlice(registry, replacementClaimJournalLength);
    const finalPayment = await registry.getBlobPayment(prepared.blobId);
    if (finalPayment.statusName !== "settled") throw new Error(`expected settled payment, got ${finalPayment.statusName}`);
    if (finalPayment.providerSettled !== finalPayment.providerPool) throw new Error("provider pool is not fully settled");

    const immediateMarker = await readGlobalMarker({
      publicClient,
      registryAddress,
      functionName: "providerSettlementClaimed",
      blobId: prepared.blobId,
      shardIndex: targetShardIndex
    });
    const reserveMarker = await readGlobalMarker({
      publicClient,
      registryAddress,
      functionName: "providerReserveClaimed",
      blobId: prepared.blobId,
      shardIndex: targetShardIndex
    });
    if (!immediateMarker || !reserveMarker) throw new Error("global settlement markers were not recorded");

    const events = await indexer.poll();
    const eventCounts = Object.fromEntries(
      [...new Set(events.map((event) => event.eventName))].map((eventName) => [
        eventName,
        events.filter((event) => event.eventName === eventName).length
      ])
    );
    const finalBlob = await registry.getBlob(prepared.blobId);
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
      blob: {
        blobId: prepared.blobId,
        name: prepared.name,
        inputBytes: input.length,
        inputSha256: sha256(input),
        commitment: prepared.commitment,
        registrationTransaction: registration.hash,
        uploadStatus: upload.status,
        statusAfterUpload: afterUpload.status,
        statusAfterRecovery: finalBlob.status,
        recoveredSha256: recovered.contentHash,
        recoveredReadSha256: recoveredReadHash,
        finalMatchesInput: recoveredReadHash === sha256(input),
        failedProviderId: originalProviderId,
        replacementProviderId,
        replacementShardIndex: targetShardIndex
      },
      payment: {
        totalPaid: paymentAfterUpload.totalPaid.toString(),
        providerPool: paymentAfterUpload.providerPool.toString(),
        providerRewardPerShard: providerRewardPerShard.toString(),
        reservePerShard: reservePerShard.toString(),
        immediateSettled: immediateSettled.toString(),
        settledAfterExpiry: finalPayment.providerSettled.toString(),
        statusAfterUpload: paymentAfterUpload.statusName,
        statusBeforeReserve: paymentBeforeReserve.statusName,
        finalStatus: finalPayment.statusName,
        replacementShardReserveOnly: replacementShardReserve.toString(),
        protocolFeesWithdrawable: finalPayment.protocolFee.toString(),
        globalImmediateMarker: immediateMarker,
        globalReserveMarker: reserveMarker,
        expiryBlockTimestamp
      },
      transactions: {
        upload: uploadTransactions,
        recovery: recoveryTransactions,
        settlement: settlementTransactions,
        replacementShardClaim: replacementShardClaim.hash,
        replacementOriginalShardClaim: replacementOriginalShardClaim.hash,
        providerThreeClaim: providerThreeClaim.hash,
        providerFourClaim: providerFourClaim.hash
      },
      providers: suite.providers.map((provider) => ({
        providerId: provider.providerId,
        endpoint: provider.url,
        operator: registry.providerOperators()[provider.providerId]
      })),
      events: {
        counts: eventCounts,
        nextBlock: indexer.nextBlock.toString()
      }
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_settlement_reassignment_complete",
      evidencePath,
      registryAddress,
      runId,
      blobId: prepared.blobId,
      failedProviderId: originalProviderId,
      replacementProviderId,
      inputSha256: sha256(input),
      recoveredSha256: recovered.contentHash,
      replacementShardReserve: replacementShardReserve.toString(),
      providerPool: finalPayment.providerPool.toString(),
      providerSettled: finalPayment.providerSettled.toString(),
      finalPaymentStatus: finalPayment.statusName,
      finalBlobStatus: finalBlob.status,
      eventCounts,
      settlementTransactions
    }, null, 2));
  } finally {
    await closeServer(rpc?.server);
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
