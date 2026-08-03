import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodePacked,
  hexToBytes,
  keccak256,
  recoverMessageAddress,
  stringToHex
} from "../rpc/node_modules/viem/_esm/index.js";
import { PrimeAuthManager } from "../rpc/src/auth.mjs";
import { createCoston2Wallet, createFlareRegistry } from "../rpc/src/flare-registry.mjs";
import { JsonOperationalStore } from "../rpc/src/operational-store.mjs";
import { createPrimeRpcServer } from "../rpc/src/server.mjs";
import { canonicalJson } from "../sdk/src/policy.mjs";
import { decryptBlob, openDeviceKeyPackage } from "../sdk/src/encryption.mjs";
import { createPrimeServerClient } from "../sdk/src/client.mjs";
import { startProviderProcesses, stopProviderProcesses } from "./providers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frozenRegistryAddress = "0x5E43cCe14cf17c96aF6d7ADF47592f5118Ab05E1";
const teeActionResultPrefix = stringToHex("TEE_ACTION_RESULT", { size: 32 });
const plaintextSize = 128 * 1024;
const instructionFeeWei = 1_000_000n;

const senderAbi = [
  {
    type: "function",
    name: "requestPrivateKeyRewrap",
    stateMutability: "payable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "keyEnvelope", type: "bytes" },
      { name: "devicePublicKey", type: "bytes" }
    ],
    outputs: [{ name: "instructionId", type: "bytes32" }]
  },
  {
    type: "function",
    name: "requestIdByInstructionId",
    stateMutability: "view",
    inputs: [{ name: "instructionId", type: "bytes32" }],
    outputs: [{ name: "requestId", type: "bytes32" }]
  }
];

const senderEventAbi = [{
  type: "event",
  name: "FccInstructionRequested",
  anonymous: false,
  inputs: [
    { name: "requestId", type: "bytes32", indexed: true },
    { name: "blobId", type: "bytes32", indexed: true },
    { name: "instructionId", type: "bytes32", indexed: true },
    { name: "opCommand", type: "bytes32", indexed: false },
    { name: "requester", type: "address", indexed: false }
  ]
}];

const verifierAbi = [
  {
    type: "function",
    name: "submitResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "resultData", type: "bytes" },
      { name: "actionId", type: "bytes32" },
      { name: "submissionTag", type: "string" },
      { name: "status", type: "uint8" },
      { name: "signature", type: "bytes" }
    ],
    outputs: []
  }
];

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
  if (!config[name]) throw new Error(`${name} is required in .env or the environment`);
  return config[name];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bytesHex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function sha256(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function walletAdapter(account) {
  return {
    address: account.address,
    signMessage: ({ message }) => account.signMessage({ message })
  };
}

function deterministicBytes(size, seed) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 37 + seed + (index >>> 8)) & 0xff;
  }
  return bytes;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForActionResult(proxyUrl, instructionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${proxyUrl.replace(/\/$/, "")}/action/result/${instructionId}`);
    lastStatus = response.status;
    if (response.ok) return response.json();
    await delay(2_000);
  }
  throw new Error(`timed out waiting for FCC result for ${instructionId}, last HTTP status ${lastStatus}`);
}

function instructionIdFromReceipt(receipt, requestId, senderAddress) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== senderAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: senderEventAbi,
        data: log.data,
        topics: log.topics
      });
      if (decoded.eventName === "FccInstructionRequested" && decoded.args.requestId.toLowerCase() === requestId.toLowerCase()) {
        return decoded.args.instructionId;
      }
    } catch {
      // Ignore unrelated logs from the same transaction.
    }
  }
  throw new Error("FccInstructionRequested event was not found in the sender receipt");
}

function officialActionResultHash(result) {
  const resultDataHash = keccak256(hexToBytes(result.data));
  const actionId = result.id;
  const submissionTagHash = keccak256(stringToHex(result.submissionTag));
  return keccak256(encodePacked(
    ["bytes32", "bytes32", "bytes32", "uint8"],
    [resultDataHash, actionId, submissionTagHash, BigInt(result.status)]
  ));
}

async function main() {
  const config = await loadConfig();
  const rpcUrl = required(config, "PRIME_SERVER_RPC_URL");
  const registryAddress = required(config, "PRIME_SERVER_REGISTRY_ADDRESS");
  const deployerPrivateKey = required(config, "PRIME_SERVER_DEPLOYER_PRIVATE_KEY");
  const authSecret = required(config, "PRIME_SERVER_AUTH_SECRET");
  const senderAddress = required(config, "PRIME_SERVER_FCC_SENDER_ADDRESS");
  const verifierAddress = required(config, "PRIME_SERVER_FCC_RESULT_VERIFIER_ADDRESS");
  const extensionId = BigInt(required(config, "PRIME_SERVER_FCC_EXTENSION_ID"));
  const teeId = required(config, "PRIME_SERVER_FCC_TEE_ID");
  const proxyUrl = required(config, "PRIME_SERVER_FCC_PROXY_URL").replace(/\/$/, "");
  const chainId = Number(config.PRIME_SERVER_CHAIN_ID || 114);
  assert(chainId === 114, `expected Coston2 chain ID 114, got ${chainId}`);
  assert(registryAddress.toLowerCase() === frozenRegistryAddress.toLowerCase(), `refusing non-frozen registry ${registryAddress}`);

  const providerIds = ["provider-1", "provider-2", "provider-3", "provider-4"];
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
  assert(await publicClient.getChainId() === chainId, "Coston2 RPC chain ID mismatch");
  const registryBytecode = await publicClient.getBytecode({ address: registryAddress });
  assert(registryBytecode && registryBytecode.length > 2, "frozen registry has no deployed bytecode");
  const registryCodeHashBefore = keccak256(hexToBytes(registryBytecode));

  const infoResponse = await fetch(`${proxyUrl}/info`);
  assert(infoResponse.ok, `FCC proxy /info returned ${infoResponse.status}`);
  const info = await infoResponse.json();
  const machineExtensionId = BigInt(info.machineData.extensionId);
  assert(machineExtensionId === extensionId, `proxy extension ID ${machineExtensionId} does not match ${extensionId}`);
  const publicKey = info.machineData.publicKey;
  const fccPublicKey = `0x04${String(publicKey.x).replace(/^0x/, "")}${String(publicKey.y).replace(/^0x/, "")}`;
  assert(fccPublicKey.length === 132, "FCC proxy did not return an uncompressed secp256k1 public key");

  const runId = `coston2-fcc-rewrap-${Date.now()}-${process.pid}`;
  const runtimeRoot = path.join(repositoryRoot, ".prime-server", "coston2", runId);
  const evidencePath = path.join(repositoryRoot, ".prime-server", "evidence", "coston2", `${runId}.json`);
  const suite = await startProviderProcesses({
    basePort: 8401 + (process.pid % 200),
    dataRoot: path.join(runtimeRoot, "providers"),
    logRoot: path.join(runtimeRoot, "logs")
  });
  const objectStore = new JsonOperationalStore(path.join(runtimeRoot, "objects.json"));
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
    const { account: ownerAccount, wallet: ownerWallet } = createCoston2Wallet({
      privateKey: deployerPrivateKey,
      rpcUrl,
      chainId
    });
    const ownerClient = createPrimeServerClient({
      baseUrl,
      wallet: walletAdapter(ownerAccount),
      walletClient: ownerWallet,
      publicClient,
      registryAddress,
      chainId
    });

    const plaintext = deterministicBytes(plaintextSize, 71);
    const sourceFilename = "private/second-device/identity-photo.png";
    const prepared = await ownerClient.prepareEncryptedBlob(plaintext, {
      storageMode: "private",
      accessPolicy: "owner_only",
      fccPublicKey,
      envelopeScheme: "flare-tee-ecies",
      metadata: {
        filename: sourceFilename,
        contentType: "image/png",
        classification: "private",
        deviceProof: "same-wallet-second-device"
      },
      expirationSeconds: 3600
    });
    const ciphertext = Buffer.from(prepared.ciphertext);
    const sourceFileKey = prepared.fileKey;
    const keyEnvelope = Buffer.from(canonicalJson(prepared.keyEnvelope));
    const plaintextSha256 = sha256(plaintext);
    const ciphertextSha256 = sha256(ciphertext);
    assert(ciphertextSha256 !== plaintextSha256, "ciphertext must differ from plaintext");
    assert(sourceFileKey.length === 32, "prepared file key must be 32 bytes before sealing");
    sourceFileKey.fill(0);

    const registration = await ownerClient.registerPaidBlob(prepared);
    const upload = await ownerClient.uploadRegisteredBlob(prepared, ciphertext, {
      contentType: "application/octet-stream"
    });
    const downloaded = await ownerClient.get(prepared.name);
    assert(Buffer.from(downloaded.bytes).equals(ciphertext), "Prime RPC did not return the stored ciphertext");
    assert(!Buffer.from(downloaded.bytes).equals(plaintext), "Prime RPC released plaintext");

    const device = ownerClient.createDeviceKeyPair();
    const access = await ownerClient.authorizeConfidentialAccess({
      blobId: prepared.blobId,
      devicePublicKey: device.publicKey,
      purpose: "view"
    });
    const accessBefore = await registry.getConfidentialAccessRequest(access.requestId);
    assert(accessBefore.exists && !accessBefore.consumed, "wallet access intent was not recorded as usable");

    const requestHash = await ownerWallet.writeContract({
      address: senderAddress,
      abi: senderAbi,
      functionName: "requestPrivateKeyRewrap",
      account: ownerWallet.account,
      args: [access.requestId, bytesHex(keyEnvelope), device.publicKey],
      value: instructionFeeWei
    });
    const requestReceipt = await publicClient.waitForTransactionReceipt({ hash: requestHash });
    assert(requestReceipt.status === "success", "FCC request transaction failed");
    const instructionId = instructionIdFromReceipt(requestReceipt, access.requestId, senderAddress);
    const boundRequestId = await publicClient.readContract({
      address: senderAddress,
      abi: senderAbi,
      functionName: "requestIdByInstructionId",
      args: [instructionId]
    });
    assert(boundRequestId.toLowerCase() === access.requestId.toLowerCase(), "sender instruction binding mismatch");

    const proxyResponse = await waitForActionResult(proxyUrl, instructionId);
    const actionResult = proxyResponse.result || proxyResponse.Result;
    const signature = proxyResponse.signature || proxyResponse.Signature;
    const proxySignature = proxyResponse.proxySignature || proxyResponse.ProxySignature;
    assert(actionResult && signature, "FCC proxy result did not include a signed ActionResult");
    assert(proxySignature, "FCC proxy result did not include the proxy signature");
    assert(Number(actionResult.status) === 1, `FCC key rewrap failed with status ${actionResult.status}`);
    assert(actionResult.id.toLowerCase() === instructionId.toLowerCase(), "FCC result ID does not match the instruction ID");
    const resultHash = officialActionResultHash(actionResult);
    const resultPayloadHash = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [teeActionResultPrefix, BigInt(chainId), resultHash]
    ));
    const recoveredTeeId = await recoverMessageAddress({
      message: { raw: hexToBytes(resultPayloadHash) },
      signature
    });
    assert(recoveredTeeId.toLowerCase() === teeId.toLowerCase(), `TEE signature recovered ${recoveredTeeId}, expected ${teeId}`);
    const resultDataBytes = hexToBytes(actionResult.data);
    const resultDataSha256 = sha256(resultDataBytes);
    const keyPackage = JSON.parse(Buffer.from(resultDataBytes).toString("utf8"));
    assert(keyPackage.requestId.toLowerCase() === access.requestId.toLowerCase(), "device key package request binding mismatch");
    assert(keyPackage.blobId.toLowerCase() === prepared.blobId.toLowerCase(), "device key package blob binding mismatch");
    assert(keyPackage.deviceKeyCommitment.toLowerCase() === device.keyCommitment.toLowerCase(), "device key package device binding mismatch");

    const submitHash = await ownerWallet.writeContract({
      address: verifierAddress,
      abi: verifierAbi,
      functionName: "submitResult",
      account: ownerWallet.account,
      args: [
        access.requestId,
        actionResult.data,
        actionResult.id,
        actionResult.submissionTag,
        Number(actionResult.status),
        signature
      ]
    });
    const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
    assert(submitReceipt.status === "success", "FCC result verification transaction failed");
    const accessAfter = await registry.getConfidentialAccessRequest(access.requestId);
    assert(accessAfter.consumed, "verified FCC result did not consume the access intent");

    const recoveredFileKey = openDeviceKeyPackage(keyPackage, device.privateKey);
    const decrypted = await decryptBlob(ciphertext, recoveredFileKey);
    const finalPlaintextSha256 = sha256(decrypted);
    assert(finalPlaintextSha256 === plaintextSha256, "second-device local decryption did not match the original plaintext");
    recoveredFileKey.fill(0);

    const registryBytecodeAfter = await publicClient.getBytecode({ address: registryAddress });
    const registryCodeHashAfter = keccak256(hexToBytes(registryBytecodeAfter));
    assert(registryCodeHashBefore === registryCodeHashAfter, "PrimeServerRegistry bytecode changed during FCC proof");

    const blobState = await registry.getBlob(prepared.blobId);
    const blobPayment = await registry.getBlobPayment(prepared.blobId);
    const evidence = {
      runId,
      status: "passed",
      proofBoundary: {
        liveCoston2: true,
        chainId,
        registryFrozen: true,
        registryBytecodeUnchanged: registryCodeHashBefore === registryCodeHashAfter,
        simulatedTee: true,
        productionConfidentialSpaceAttestation: false,
        officialFccProxyResultPath: true,
        registeredTeeSignatureVerifiedOnchain: true,
        originalFileKeyReusedAfterSealing: false,
        confidentialComputeLive: false,
        xrpSettlementLive: false
      },
      deployment: {
        registryAddress,
        registryCodeHash: registryCodeHashBefore,
        senderAddress,
        verifierAddress,
        extensionId: extensionId.toString(),
        teeId,
        proxyUrl,
        senderRequestTransaction: requestHash,
        verifierSubmitTransaction: submitHash
      },
      privateBlob: {
        blobId: prepared.blobId,
        sourceFilename,
        onchainName: blobState.blobName,
        opaqueOnchainName: /^private\/[a-f0-9]{64}$/.test(blobState.blobName),
        sourceFilenameAbsentFromOnchainName: !blobState.blobName.includes(sourceFilename),
        plaintextBytes: plaintext.length,
        ciphertextBytes: ciphertext.length,
        plaintextSha256,
        ciphertextSha256,
        downloadedCiphertextSha256: sha256(Buffer.from(downloaded.bytes)),
        ciphertextDiffersFromPlaintext: ciphertextSha256 !== plaintextSha256,
        clayCommitment: prepared.commitment,
        onchainClayCommitment: blobState.commitment,
        keyEnvelopeCommitment: prepared.keyEnvelopeCommitment,
        metadataCommitment: prepared.metadataCommitment,
        onchainKeyEnvelopeCommitment: blobState.policy.keyEnvelopeCommitment,
        onchainMetadataCommitment: blobState.policy.metadataCommitment,
        paymentRegistrationTransaction: registration.hash,
        uploadStatus: upload.status,
        paymentStatus: blobPayment.statusName,
        rpcReturnedCiphertextOnly: true
      },
      access: {
        sameWallet: true,
        wallet: ownerAccount.address,
        deviceKeyCommitment: device.keyCommitment,
        accessRequestId: access.requestId,
        accessAuthorizationTransaction: access.hash,
        accessRequest: accessBefore,
        senderRequestTransaction: requestHash,
        senderRequestBlock: requestReceipt.blockNumber?.toString() || null,
        instructionId,
        instructionRequestBinding: boundRequestId,
        officialActionResult: {
          id: actionResult.id,
          submissionTag: actionResult.submissionTag,
          status: Number(actionResult.status),
          dataSha256: resultDataSha256,
          teeSignature: signature,
          proxySignaturePresent: Boolean(proxySignature),
          signedPayloadHash: resultPayloadHash,
          locallyRecoveredTeeId: recoveredTeeId
        },
        verifierSubmitTransaction: submitHash,
        verifierSubmitBlock: submitReceipt.blockNumber?.toString() || null,
        consumedRequest: accessAfter,
        deviceKeyPackageScheme: keyPackage.scheme,
        deviceKeyPackageRequestBinding: keyPackage.requestId,
        deviceKeyPackageBlobBinding: keyPackage.blobId,
        localDecryptionSha256: finalPlaintextSha256,
        localDecryptionMatchesOriginal: finalPlaintextSha256 === plaintextSha256,
        sourceFileKeyZeroedBeforeRegistration: true,
        secondDeviceInputs: ["same wallet", "new device key pair", "ciphertext", "FCC-returned wrapped key package"]
      },
      transactions: registry.transactionJournal()
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      event: "coston2_fcc_key_rewrap_demo_complete",
      evidencePath,
      registryAddress,
      senderAddress,
      verifierAddress,
      extensionId: extensionId.toString(),
      teeId,
      blobId: prepared.blobId,
      opaqueName: blobState.blobName,
      instructionId,
      requestHash,
      submitHash,
      plaintextSha256,
      ciphertextSha256,
      localDecryptionSha256: finalPlaintextSha256,
      registryBytecodeUnchanged: registryCodeHashBefore === registryCodeHashAfter
    }, null, 2));
  } finally {
    if (rpc?.server?.listening) {
      await new Promise((resolve, reject) => rpc.server.close((error) => error ? reject(error) : resolve()));
    }
    await stopProviderProcesses({ providers: suite.providers });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
