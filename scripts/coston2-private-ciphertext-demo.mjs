import { createECDH, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrimeAuthManager } from "../rpc/src/auth.mjs";
import { createFlareRegistry, createCoston2Wallet } from "../rpc/src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../rpc/src/event-indexer.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { PrimeServerRecoveryCoordinator } from "../rpc/src/recovery-coordinator.mjs";
import { createPrimeRpcServer, rebuildBlob } from "../rpc/src/server.mjs";
import { decryptBlob } from "../sdk/src/encryption.mjs";
import { createPrimeServerClient } from "../sdk/src/client.mjs";
import { startProviderProcess, startProviderProcesses, stopProviderProcesses } from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frozenRegistryAddress = "0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1";
const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];
const failedProviderIndexes = [1, 3];
const missingShardIndexes = [1, 3];
const plaintextSize = 1024 * 1024;

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

function required(config, name) {
  if (!config[name]) throw new Error(`${name} is required in .env`);
  return config[name];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedBlobId(blobId) {
  return String(blobId).replace(/^0x/, "");
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function deterministicBytes(size, seed) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 37 + seed + (index >>> 8)) & 0xff;
  }
  return bytes;
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
    moved.push({ source, destination });
  }
  return moved;
}

async function requestClientBytes(client, name, { account, accessRequestId } = {}) {
  const resolvedAccount = account || client.wallet?.address || client.walletClient?.account?.address;
  const headers = accessRequestId ? { "x-prime-access-request-id": accessRequestId } : {};
  const response = await client.request(`/blobs/${encodePath(resolvedAccount)}/${encodePath(name)}`, {
    headers,
    auth: true
  });
  return {
    response,
    bytes: Buffer.from(await response.arrayBuffer())
  };
}

async function requestProviderShard(provider, blobId, shardIndex) {
  const response = await fetch(`${provider.url}/v1/shards/${encodePath(blobId)}/${shardIndex}`);
  if (!response.ok) throw new Error(`provider ${provider.providerId} returned ${response.status} for shard ${shardIndex}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    providerId: provider.providerId,
    shardIndex,
    bytes,
    size: bytes.length,
    sha256: sha256(bytes),
    commitment: response.headers.get("x-prime-shard-commitment")
  };
}

async function readRawContent(rpcBaseUrl, blobId) {
  const response = await fetch(`${rpcBaseUrl}/v1/blobs/${encodePath(blobId)}/content`);
  return {
    status: response.status,
    body: await response.text()
  };
}

function journalSlice(registry, start) {
  return registry.transactionJournal().slice(start).map((entry) => ({
    functionName: entry.functionName,
    hash: entry.hash,
    blockNumber: entry.blockNumber,
    status: entry.status
  }));
}

function walletAdapter(account) {
  return {
    address: account.address,
    signMessage: ({ message }) => account.signMessage({ message })
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const config = await loadConfig();
  const rpcUrl = required(config, "PRIME_SERVER_RPC_URL");
  const registryAddress = required(config, "PRIME_SERVER_REGISTRY_ADDRESS");
  const deployerPrivateKey = required(config, "PRIME_SERVER_DEPLOYER_PRIVATE_KEY");
  const authSecret = required(config, "PRIME_SERVER_AUTH_SECRET");
  const chainId = Number(config.PRIME_SERVER_CHAIN_ID || 114);
  if (chainId !== 114) throw new Error(`expected Coston2 chain ID 114, got ${chainId}`);
  if (registryAddress.toLowerCase() !== frozenRegistryAddress.toLowerCase()) {
    throw new Error(`refusing to run against non-frozen registry ${registryAddress}`);
  }

  const providerPrivateKeys = Object.fromEntries(providerIds.map((providerId, index) => [
    providerId,
    required(config, `PRIME_SERVER_PROVIDER_${index + 1}_PRIVATE_KEY`)
  ]));
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
  if (!bytecode || bytecode.length <= 2) throw new Error("frozen registry address has no deployed bytecode");

  const runId = `coston2-private-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const deploymentBlock = config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK
    ? BigInt(config.PRIME_SERVER_REGISTRY_DEPLOYMENT_BLOCK)
    : null;
  const runStartBlock = await publicClient.getBlockNumber();
  const suite = await startProviderProcesses({
    basePort: 8101 + (process.pid % 300),
    dataRoot: path.join(runtimeRoot, "providers"),
    logRoot: path.join(runtimeRoot, "logs")
  });
  const objectStore = new JsonOperationalStore(path.join(runtimeRoot, "objects.json"));
  const authManager = new PrimeAuthManager({
    secret: authSecret,
    domain: config.PRIME_SERVER_AUTH_DOMAIN || "api.primeserver"
  });
  let rpc;
  let recoveryCoordinator;

  try {
    recoveryCoordinator = new PrimeServerRecoveryCoordinator({
      store: objectStore,
      workerId: `coston2-private-${process.pid}`,
      recover: async (blobId) => rebuildBlob({
        blobId,
        providers: suite.providers,
        registry,
        erasureEngine: rpc.erasureEngine
      })
    });
    rpc = await createPrimeRpcServer({
      providers: suite.providers,
      registry,
      objectStore,
      authManager,
      recoveryCoordinator,
      publicBaseUrl: "http://127.0.0.1/prime/v1"
    });

    await new Promise((resolve) => rpc.server.listen(0, "127.0.0.1", resolve));
    const port = rpc.server.address().port;
    const rpcRoot = `http://127.0.0.1:${port}`;
    const baseUrl = `${rpcRoot}/prime/v1`;
    const indexer = new PrimeServerEventIndexer({
      publicClient,
      address: registryAddress,
      fromBlock: runStartBlock + 1n
    });

    const ownerPrivateKey = `0x${createHash("sha256").update(`${runId}:owner`).digest("hex")}`;
    const selectedPrivateKey = `0x${createHash("sha256").update(`${runId}:selected-wallet`).digest("hex")}`;
    const { account: ownerAccount, wallet: ownerWallet } = createCoston2Wallet({
      privateKey: ownerPrivateKey,
      rpcUrl,
      chainId
    });
    const { account: selectedAccount, wallet: selectedWallet } = createCoston2Wallet({
      privateKey: selectedPrivateKey,
      rpcUrl,
      chainId
    });
    const { wallet: deployerWallet } = createCoston2Wallet({
      privateKey: deployerPrivateKey,
      rpcUrl,
      chainId
    });

    const fundingTransactions = [];
    const fundingRequests = [
      { recipient: ownerAccount.address, amount: 5_000_000_000_000_000_000n },
      { recipient: selectedAccount.address, amount: 2_000_000_000_000_000_000n }
    ];
    for (const { recipient, amount } of fundingRequests) {
      const hash = await deployerWallet.sendTransaction({
        to: recipient,
        value: amount
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      fundingTransactions.push({
        recipient,
        amountWei: amount.toString(),
        hash,
        blockNumber: receipt.blockNumber?.toString() || null,
        status: receipt.status
      });
    }

    const ownerClient = createPrimeServerClient({
      baseUrl,
      wallet: walletAdapter(ownerAccount),
      walletClient: ownerWallet,
      publicClient,
      registryAddress,
      chainId
    });
    const selectedClient = createPrimeServerClient({
      baseUrl,
      wallet: walletAdapter(selectedAccount),
      walletClient: selectedWallet,
      publicClient,
      registryAddress,
      chainId
    });

    const fccRecipientKey = createECDH("secp256k1");
    fccRecipientKey.generateKeys();
    const originalFilename = "private/customer-acquisition/private-valuation.pdf";
    const privatePlaintext = deterministicBytes(plaintextSize, 23);
    const privatePrepared = await ownerClient.prepareEncryptedBlob(privatePlaintext, {
      name: originalFilename,
      storageMode: "private",
      accessPolicy: "selected_wallets",
      allowedWallets: [selectedAccount.address],
      fccPublicKey: `0x${fccRecipientKey.getPublicKey().toString("hex")}`,
      metadata: {
        filename: originalFilename,
        contentType: "application/pdf",
        classification: "restricted",
        selectedWallet: selectedAccount.address
      },
      expirationSeconds: 3600
    });
    const privatePlaintextSha256 = sha256(privatePlaintext);
    const privateCiphertextSha256 = sha256(privatePrepared.ciphertext);
    assert(privateCiphertextSha256 !== privatePlaintextSha256, "ciphertext must differ from plaintext");

    const privateRegistrationJournalStart = registry.transactionJournal().length;
    const privateRegistration = await ownerClient.registerPaidBlob(privatePrepared);
    const selectedWalletAccess = await registry.setBlobWalletAccess({
      blobId: privatePrepared.blobId,
      wallet: selectedAccount.address,
      allowed: true,
      controllerWallet: ownerWallet
    });
    const privateUpload = await ownerClient.uploadRegisteredBlob(privatePrepared, privatePrepared.ciphertext, {
      contentType: "application/octet-stream"
    });
    const privateStateAfterUpload = await registry.getBlob(privatePrepared.blobId);
    const privatePaymentAfterUpload = await registry.getBlobPayment(privatePrepared.blobId);
    assert(privateStateAfterUpload?.blobName === privatePrepared.name, "onchain private name must match the prepared opaque name");
    assert(privateStateAfterUpload?.policy?.storageModeName === "private", "onchain private policy was not recorded");
    assert(privateStateAfterUpload?.policy?.accessPolicyName === "selected_wallets", "onchain selected-wallet policy was not recorded");

    const ownerBeforeFailure = await requestClientBytes(ownerClient, privatePrepared.name);
    assert(ownerBeforeFailure.bytes.equals(privatePrepared.ciphertext), "owner download must return the encrypted bytes");
    assert(!ownerBeforeFailure.bytes.equals(privatePlaintext), "owner download must not return plaintext");

    const providerShardsBeforeFailure = [];
    for (let shardIndex = 0; shardIndex < suite.providers.length; shardIndex += 1) {
      const shard = await requestProviderShard(suite.providers[shardIndex], normalizedBlobId(privatePrepared.blobId), shardIndex);
      providerShardsBeforeFailure.push({
        providerId: shard.providerId,
        shardIndex: shard.shardIndex,
        size: shard.size,
        sha256: shard.sha256,
        commitment: shard.commitment,
        equalsPlaintext: shard.bytes.equals(privatePlaintext),
        containsCompletePlaintext: shard.bytes.includes(privatePlaintext)
      });
    }
    assert(providerShardsBeforeFailure.every((shard) => !shard.equalsPlaintext), "a provider returned the plaintext as a shard");
    assert(providerShardsBeforeFailure.every((shard) => !shard.containsCompletePlaintext), "a provider shard contains the complete plaintext");

    const selectedDevice = selectedClient.createDeviceKeyPair();
    const selectedAccess = await selectedClient.authorizeConfidentialAccess({
      blobId: privatePrepared.blobId,
      devicePublicKey: selectedDevice.publicKey,
      purpose: "view"
    });
    const selectedAccessState = await registry.getConfidentialAccessRequest(selectedAccess.requestId);
    const selectedAccessUsable = await registry.isConfidentialAccessUsable(selectedAccess.requestId);
    const selectedBeforeFailure = await requestClientBytes(selectedClient, privatePrepared.name, {
      account: ownerAccount.address,
      accessRequestId: selectedAccess.requestId
    });
    assert(selectedBeforeFailure.bytes.equals(privatePrepared.ciphertext), "selected wallet must retrieve ciphertext");
    assert(!selectedBeforeFailure.bytes.equals(privatePlaintext), "selected wallet must not receive plaintext from RPC");

    const failureStartedAt = new Date().toISOString();
    const failedProviders = failedProviderIndexes.map((index) => suite.providers[index]);
    await stopProviderProcesses({ providers: failedProviders });
    const ownerDuringFailure = await requestClientBytes(ownerClient, privatePrepared.name);
    assert(ownerDuringFailure.bytes.equals(privatePrepared.ciphertext), "ciphertext recovery read must match the uploaded ciphertext");
    assert(ownerDuringFailure.response.headers.get("x-prime-recovered") === "true", "RPC did not report ciphertext recovery");
    const reportedMissingShards = (ownerDuringFailure.response.headers.get("x-prime-missing-shards") || "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    assert(missingShardIndexes.every((shardIndex) => reportedMissingShards.includes(shardIndex)), "RPC did not report both missing ciphertext shards");

    const lostShardFiles = [];
    for (const shardIndex of missingShardIndexes) {
      lostShardFiles.push(...await preserveLostShard(suite.providers[shardIndex], normalizedBlobId(privatePrepared.blobId), shardIndex));
    }
    for (const index of failedProviderIndexes) {
      const previous = suite.providers[index];
      suite.providers[index] = await startProviderProcess({
        providerId: previous.providerId,
        port: previous.port,
        dataDir: previous.dataDir,
        logPath: previous.logPath
      });
    }

    const recoveryJournalStart = registry.transactionJournal().length;
    const recoveryResponse = await fetch(`${rpcRoot}/v1/blobs/${encodePath(normalizedBlobId(privatePrepared.blobId))}/recover`, {
      method: "POST"
    });
    const recoveryBody = await recoveryResponse.json();
    if (!recoveryResponse.ok) throw new Error(`ciphertext recovery returned ${recoveryResponse.status}: ${recoveryBody.error || "recovery failed"}`);
    const recoveryJournal = journalSlice(registry, recoveryJournalStart);
    const finalPrivate = await requestClientBytes(ownerClient, privatePrepared.name);
    const finalPrivatePlaintext = await decryptBlob(finalPrivate.bytes, privatePrepared.fileKey);
    assert(finalPrivate.bytes.equals(privatePrepared.ciphertext), "rebuilt ciphertext must match the original ciphertext");
    assert(finalPrivatePlaintext.equals(privatePlaintext), "locally decrypted recovered ciphertext must match the plaintext");
    assert(finalPrivate.response.headers.get("x-prime-recovered") === "false", "final ciphertext read should use rebuilt shards");

    const selectedAfterRecovery = await requestClientBytes(selectedClient, privatePrepared.name, {
      account: ownerAccount.address,
      accessRequestId: selectedAccess.requestId
    });
    assert(selectedAfterRecovery.bytes.equals(privatePrepared.ciphertext), "selected wallet must retrieve rebuilt ciphertext");

    const providerShardsAfterRecovery = [];
    for (let shardIndex = 0; shardIndex < suite.providers.length; shardIndex += 1) {
      const shard = await requestProviderShard(suite.providers[shardIndex], normalizedBlobId(privatePrepared.blobId), shardIndex);
      providerShardsAfterRecovery.push({
        providerId: shard.providerId,
        shardIndex: shard.shardIndex,
        size: shard.size,
        sha256: shard.sha256,
        commitment: shard.commitment,
        equalsPlaintext: shard.bytes.equals(privatePlaintext),
        containsCompletePlaintext: shard.bytes.includes(privatePlaintext)
      });
    }
    assert(providerShardsAfterRecovery.every((shard) => !shard.equalsPlaintext), "rebuilt provider returned the plaintext as a shard");

    const confidentialPlaintext = Buffer.from(`compute-only input ${runId}`);
    const confidentialPrepared = await ownerClient.prepareEncryptedBlob(confidentialPlaintext, {
      name: "private/compute-only-source.json",
      storageMode: "confidential",
      accessPolicy: "compute_only",
      fccPublicKey: `0x${fccRecipientKey.getPublicKey().toString("hex")}`,
      metadata: {
        filename: "private/compute-only-source.json",
        contentType: "application/json",
        operation: "approved-summary"
      },
      expirationSeconds: 3600
    });
    const confidentialRegistration = await ownerClient.registerPaidBlob(confidentialPrepared);
    const confidentialUpload = await ownerClient.uploadRegisteredBlob(confidentialPrepared, confidentialPrepared.ciphertext, {
      contentType: "application/octet-stream"
    });
    const confidentialState = await registry.getBlob(confidentialPrepared.blobId);
    const confidentialRaw = await readRawContent(rpcRoot, normalizedBlobId(confidentialPrepared.blobId));
    let confidentialDeveloperStatus = null;
    let confidentialDeveloperError = null;
    try {
      await ownerClient.get(confidentialPrepared.name);
    } catch (error) {
      confidentialDeveloperStatus = error.status || null;
      confidentialDeveloperError = error.message;
    }
    assert(confidentialRaw.status === 403, "raw compute-only content route must be blocked");
    assert(confidentialDeveloperStatus === 403, "developer compute-only content route must be blocked");

    const indexedEvents = await indexer.poll();
    const eventCounts = Object.fromEntries(
      [...new Set(indexedEvents.map((event) => event.eventName))].map((eventName) => [
        eventName,
        indexedEvents.filter((event) => event.eventName === eventName).length
      ])
    );
    const finalPrivateState = await registry.getBlob(privatePrepared.blobId);
    const finalPrivatePayment = await registry.getBlobPayment(privatePrepared.blobId);
    const evidence = {
      runId,
      status: "passed",
      proofBoundary: {
        liveCoston2: true,
        registryFrozen: true,
        registryModified: false,
        fccLiveKeyRelease: false,
        confidentialComputeLive: false,
        xrpSettlementLive: false
      },
      chainId: actualChainId,
      registry: {
        address: registryAddress,
        deploymentBlock: deploymentBlock?.toString() || null,
        deploymentTransaction: config.PRIME_SERVER_REGISTRY_DEPLOYMENT_TX_HASH || null,
        bytecodeBytes: Math.floor((bytecode.length - 2) / 2)
      },
      funding: fundingTransactions,
      privateBlob: {
        blobId: privatePrepared.blobId,
        sourceFilename: originalFilename,
        onchainName: privateStateAfterUpload.blobName,
        opaqueOnchainName: /^private\/[a-f0-9]{64}$/.test(privateStateAfterUpload.blobName),
        sourceFilenameAbsentFromOnchainName: !privateStateAfterUpload.blobName.includes(originalFilename),
        size: {
          plaintextBytes: privatePlaintext.length,
          ciphertextBytes: privatePrepared.ciphertext.length,
          ciphertextHasEncryptionOverhead: privatePrepared.ciphertext.length > privatePlaintext.length
        },
        hashes: {
          plaintextSha256: privatePlaintextSha256,
          ciphertextSha256: privateCiphertextSha256,
          ownerDownloadedCiphertextSha256: sha256(ownerBeforeFailure.bytes),
          failureRecoveryCiphertextSha256: sha256(ownerDuringFailure.bytes),
          finalRecoveredCiphertextSha256: sha256(finalPrivate.bytes),
          finalDecryptedPlaintextSha256: sha256(finalPrivatePlaintext),
          ciphertextDiffersFromPlaintext: privateCiphertextSha256 !== privatePlaintextSha256,
          finalDecryptionMatchesOriginal: sha256(finalPrivatePlaintext) === privatePlaintextSha256
        },
        commitments: {
          clayCiphertextCommitment: privatePrepared.commitment,
          policyCommitment: privatePrepared.policy.policyCommitment,
          keyEnvelopeCommitment: privatePrepared.keyEnvelopeCommitment,
          metadataCommitment: privatePrepared.metadataCommitment,
          onchainClayCiphertextCommitment: privateStateAfterUpload.commitment,
          onchainPolicyCommitment: privateStateAfterUpload.policy.policyCommitment,
          onchainKeyEnvelopeCommitment: privateStateAfterUpload.policy.keyEnvelopeCommitment,
          onchainMetadataCommitment: privateStateAfterUpload.policy.metadataCommitment,
          envelopeAndMetadataCommitmentsMatch: privatePrepared.keyEnvelopeCommitment.replace(/^0x/, "") === privateStateAfterUpload.policy.keyEnvelopeCommitment
            && privatePrepared.metadataCommitment.replace(/^0x/, "") === privateStateAfterUpload.policy.metadataCommitment
        },
        policy: {
          storageMode: privateStateAfterUpload.policy.storageModeName,
          accessPolicy: privateStateAfterUpload.policy.accessPolicyName,
          metadataFieldsSealedInEnvelope: ["filename", "contentType", "classification", "selectedWallet"],
          fccRecipientKeyMaterial: "generated test recipient key used only to seal the envelope"
        },
        payment: {
          registrationTransaction: privateRegistration.hash,
          quote: Object.fromEntries(Object.entries(privateRegistration.quote).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value
          ])),
          uploadStatus: privateUpload.status,
          statusAfterUpload: privatePaymentAfterUpload.statusName,
          finalStatus: finalPrivatePayment.statusName,
          providerSettled: finalPrivatePayment.providerSettled.toString()
        },
        ownerUpload: {
          owner: ownerAccount.address,
          transactionJournal: journalSlice(registry, privateRegistrationJournalStart),
          responseStatus: privateUpload.status,
          downloadedBytesAreCiphertext: ownerBeforeFailure.bytes.equals(privatePrepared.ciphertext),
          rpcReleasedPlaintext: ownerBeforeFailure.bytes.equals(privatePlaintext)
        },
        selectedWallet: {
          wallet: selectedAccount.address,
          onchainAuthorizationTransaction: selectedWalletAccess.hash,
          accessRequestId: selectedAccess.requestId,
          accessAuthorizationTransaction: selectedAccess.hash,
          requester: selectedAccessState.requester,
          purpose: selectedAccessState.purpose,
          nonce: selectedAccessState.nonce.toString(),
          deviceKeyCommitment: selectedAccessState.deviceKeyCommitment,
          usableOnchain: selectedAccessUsable,
          beforeRecovery: {
            status: selectedBeforeFailure.response.status,
            ciphertextSha256: sha256(selectedBeforeFailure.bytes),
            returnedBytesEqualCiphertext: selectedBeforeFailure.bytes.equals(privatePrepared.ciphertext),
            rpcReleasedPlaintext: selectedBeforeFailure.bytes.equals(privatePlaintext)
          },
          afterRecovery: {
            status: selectedAfterRecovery.response.status,
            ciphertextSha256: sha256(selectedAfterRecovery.bytes),
            returnedBytesEqualCiphertext: selectedAfterRecovery.bytes.equals(privatePrepared.ciphertext),
            rpcReleasedPlaintext: selectedAfterRecovery.bytes.equals(privatePlaintext)
          }
        },
        providers: {
          registered: suite.providers.map((provider) => ({
            providerId: provider.providerId,
            endpoint: provider.url,
            operator: registry.providerOperators()[provider.providerId]
          })),
          initialShardBytes: providerShardsBeforeFailure,
          storedBytesAreNotPlaintext: providerShardsBeforeFailure.every((shard) => !shard.equalsPlaintext),
          noShardContainsCompletePlaintext: providerShardsBeforeFailure.every((shard) => !shard.containsCompletePlaintext),
          failedProviderIds: failedProviders.map((provider) => provider.providerId),
          missingShardIndexes,
          failureStartedAt,
          recoveryResponse: recoveryBody,
          recoveredRead: {
            status: ownerDuringFailure.response.status,
            recoveredHeader: ownerDuringFailure.response.headers.get("x-prime-recovered"),
            missingShardHeader: ownerDuringFailure.response.headers.get("x-prime-missing-shards"),
            ciphertextSha256: sha256(ownerDuringFailure.bytes)
          },
          rebuiltShardBytes: providerShardsAfterRecovery,
          rebuiltBytesAreNotPlaintext: providerShardsAfterRecovery.every((shard) => !shard.equalsPlaintext),
          lostShardFiles
        },
        finalState: {
          status: finalPrivateState.status,
          acknowledgementCount: finalPrivateState.acknowledgementCount,
          providerPlacement: finalPrivateState.placement
        }
      },
      confidentialComputeOnlyGuard: {
        blobId: confidentialPrepared.blobId,
        onchainName: confidentialState.blobName,
        storageMode: confidentialState.policy.storageModeName,
        accessPolicy: confidentialState.policy.accessPolicyName,
        ciphertextCommitment: confidentialPrepared.commitment,
        registrationTransaction: confidentialRegistration.hash,
        uploadStatus: confidentialUpload.status,
        rawContentRouteStatus: confidentialRaw.status,
        rawContentRouteBlocked: confidentialRaw.status === 403,
        developerRouteStatus: confidentialDeveloperStatus,
        developerRouteBlocked: confidentialDeveloperStatus === 403,
        developerRouteError: confidentialDeveloperError,
        plaintextReleased: false
      },
      events: {
        counts: eventCounts,
        nextBlock: indexer.nextBlock.toString()
      },
      transactions: registry.transactionJournal()
    };

    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_private_ciphertext_demo_complete",
      evidencePath,
      registryAddress,
      runId,
      owner: ownerAccount.address,
      selectedWallet: selectedAccount.address,
      privateBlobId: privatePrepared.blobId,
      privateName: privatePrepared.name,
      plaintextSha256: privatePlaintextSha256,
      ciphertextSha256: privateCiphertextSha256,
      finalDecryptedSha256: sha256(finalPrivatePlaintext),
      selectedWalletCiphertext: selectedAfterRecovery.bytes.equals(privatePrepared.ciphertext),
      providerRecoveryCiphertext: finalPrivate.bytes.equals(privatePrepared.ciphertext),
      confidentialRawStatus: confidentialRaw.status,
      confidentialDeveloperStatus,
      privatePaymentStatus: finalPrivatePayment.statusName
    }, null, 2));
  } finally {
    await closeServer(rpc?.server);
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
