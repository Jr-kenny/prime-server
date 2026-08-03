import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createECDH, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProviderProcess, startProviderProcesses, stopProviderProcesses, waitForProcessExit } from "../../scripts/providers.mjs";
import { createCoston2Chain, createFlareRegistry } from "../src/flare-registry.mjs";
import { createPrimeRpcServer } from "../src/server.mjs";
import { PrimeAuthManager } from "../src/auth.mjs";
import { JsonOperationalStore } from "../src/operational-store.mjs";
import { decryptBlob } from "../../sdk/src/encryption.mjs";
import { createPrimeServerClient } from "../../sdk/src/client.mjs";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const execFile = promisify(execFileCallback);
const deployerPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
      });
      if ((await response.json()).result) return;
    } catch {
      // Anvil may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local EVM did not start");
}

async function deployRegistry(rpcUrl) {
  const { stdout } = await execFile(
    "forge",
    ["create", "--broadcast", "--rpc-url", rpcUrl, "--private-key", deployerPrivateKey, "src/PrimeServerRegistry.sol:PrimeServerRegistry"],
    { cwd: new URL("../../contracts/", import.meta.url), maxBuffer: 8 * 1024 * 1024 }
  );
  const match = stdout.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) throw new Error(`deployment address missing: ${stdout}`);
  return match[1];
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Prime RPC writes an upload lifecycle to a real local EVM registry", async () => {
  const port = 21_000 + (process.pid % 500);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-flare-rpc-"));
  const providerPrivateKeys = Object.fromEntries(
    ["provider-1", "provider-2", "provider-3", "provider-4"].map((providerId) => [providerId, generatePrivateKey()])
  );

  try {
    await waitForRpc(rpcUrl);
    const chain = createCoston2Chain(rpcUrl, 31337);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployerWallet = createWalletClient({
      account: privateKeyToAccount(deployerPrivateKey),
      chain,
      transport: http(rpcUrl)
    });
    for (const privateKey of Object.values(providerPrivateKeys)) {
      const account = privateKeyToAccount(privateKey);
      const hash = await deployerWallet.sendTransaction({ to: account.address, value: parseEther("1") });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    const address = await deployRegistry(rpcUrl);
    const registry = createFlareRegistry({
      address,
      rpcUrl,
      chainId: 31337,
      deployerPrivateKey,
      providerPrivateKeys
    });
    const suite = await startProviderProcesses({
      basePort: 22_000 + (process.pid % 500),
      dataRoot: path.join(root, "providers"),
      logRoot: path.join(root, "logs")
    });
    const rpc = await createPrimeRpcServer({
      providers: suite.providers,
      registry,
      objectStore: new JsonOperationalStore(path.join(root, "objects.json")),
      authManager: new PrimeAuthManager({ secret: "b".repeat(64), domain: "localhost" })
    });
    await new Promise((resolve) => rpc.server.listen(0, "127.0.0.1", resolve));
    const rpcAddress = rpc.server.address();
    const input = Buffer.alloc(2 * 1024 * 1024, 7);

    try {
      const response = await fetch(`http://127.0.0.1:${rpcAddress.port}/v1/blobs`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: input
      });
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.equal(result.status, "active");
      assert.equal(result.providers.length, 4);

      const onchain = await registry.getBlob(result.blobId);
      assert.equal(onchain.acknowledgementCount, 4);
      assert.equal(onchain.status, "active");
      assert.equal(onchain.commitment, result.commitment);
      assert.ok((await publicClient.getBytecode({ address })).length > 2);
      assert.match(result.commitment, /^[0-9a-f]{64}$/);

      const stopped = [suite.providers[1], suite.providers[3]];
      const stoppedExits = stopped.map((provider) => waitForProcessExit(provider.child));
      for (const provider of stopped) provider.child.kill("SIGTERM");
      await Promise.all(stoppedExits);
      const recovered = await fetch(`http://127.0.0.1:${rpcAddress.port}/v1/blobs/${result.blobId}/content`);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.headers.get("x-prime-recovered"), "true");
      assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), input);

      for (const shardIndex of [1, 3]) {
        const stoppedProvider = suite.providers[shardIndex];
        await rm(path.join(stoppedProvider.dataDir, `${result.blobId}.${shardIndex}.shard`), { force: true });
        await rm(path.join(stoppedProvider.dataDir, `${result.blobId}.${shardIndex}.json`), { force: true });
      }
      await stopProviderProcesses({ providers: stopped });
      for (const shardIndex of [1, 3]) {
        const oldProvider = suite.providers[shardIndex];
        suite.providers[shardIndex] = await startProviderProcess({
          providerId: oldProvider.providerId,
          port: oldProvider.port,
          dataDir: oldProvider.dataDir,
          logPath: oldProvider.logPath
        });
      }

      const rebuild = await fetch(`http://127.0.0.1:${rpcAddress.port}/v1/blobs/${result.blobId}/recover`, { method: "POST" });
      assert.equal(rebuild.status, 200);
      const rebuildResult = await rebuild.json();
      assert.deepEqual(rebuildResult.rebuiltShards.map((shard) => shard.shardIndex), [1, 3]);
      assert.equal(rebuildResult.status, "rebuilt");
      const rebuiltOnchain = await registry.getBlob(result.blobId);
      assert.equal(rebuiltOnchain.status, "rebuilt");

      const user = privateKeyToAccount(generatePrivateKey());
      const userWallet = createWalletClient({ account: user, chain, transport: http(rpcUrl) });
      const fundingHash = await deployerWallet.sendTransaction({ to: user.address, value: parseEther("1") });
      await publicClient.waitForTransactionReceipt({ hash: fundingHash });
      const paidInput = Buffer.alloc(2 * 1024 * 1024, 9);
      const paidEncoded = rpc.erasureEngine.encode(paidInput);
      const paidBlobId = createHash("sha256").update("paid-local-blob").digest("hex");
      const paidBlobName = "paid/report.bin";
      const paidExpiresAt = Math.floor(Date.now() / 1000) + 3600;
      const policyCommitment = `0x${createHash("sha256").update("public-owner-only-policy").digest("hex")}`;
      const zeroBytes32 = `0x${"00".repeat(32)}`;
      const quote = await registry.quoteNativePayment({ size: paidInput.length, totalShards: 4, storageMode: 0, expiresAt: paidExpiresAt });
      await registry.createBlobNamedPaid({
        wallet: userWallet,
        registration: {
          blobId: paidBlobId,
          blobName: paidBlobName,
          commitment: paidEncoded.clayChunksetRoot,
          size: paidInput.length,
          chunkSize: rpc.erasureEngine.config.chunkSizeBytes,
          dataShards: rpc.erasureEngine.config.k,
          totalShards: rpc.erasureEngine.config.n,
          expiresAt: paidExpiresAt,
          storageMode: 0,
          accessPolicy: 0,
          policyCommitment,
          keyEnvelopeCommitment: zeroBytes32,
          metadataCommitment: zeroBytes32
        },
        value: quote.total
      });

      const challenge = await (await fetch(`http://127.0.0.1:${rpcAddress.port}/prime/v1/auth/challenge?address=${user.address}`)).json();
      const signature = await user.signMessage({ message: challenge.message });
      const session = await (await fetch(`http://127.0.0.1:${rpcAddress.port}/prime/v1/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: user.address, nonce: challenge.nonce, signature })
      })).json();
      const paidPutResponse = await fetch(`http://127.0.0.1:${rpcAddress.port}/prime/v1/blobs/${user.address}/${encodeURIComponent(paidBlobName)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/octet-stream",
          "x-prime-blob-id": `0x${paidBlobId}`,
          "x-prime-commitment": `0x${paidEncoded.clayChunksetRoot}`,
          "x-prime-chunk-size": String(rpc.erasureEngine.config.chunkSizeBytes),
          "x-prime-data-shards": String(rpc.erasureEngine.config.k),
          "x-prime-total-shards": String(rpc.erasureEngine.config.n),
          "x-prime-expires-at": String(paidExpiresAt),
          "x-prime-storage-mode": "0",
          "x-prime-access-policy": "0",
          "x-prime-policy-commitment": policyCommitment,
          "x-prime-key-envelope-commitment": zeroBytes32,
          "x-prime-metadata-commitment": zeroBytes32
        },
        body: paidInput
      });
      const paidPutBody = await paidPutResponse.text();
      assert.equal(paidPutResponse.status, 201, paidPutBody);
      const paidPut = JSON.parse(paidPutBody);
      assert.equal(paidPut.paymentStatus, "partially_settled");
      assert.equal(paidPut.providerSettlements.length, 4);
      assert.equal((await registry.getBlobPayment(paidBlobId)).statusName, "partially_settled");

      const teeKey = createECDH("secp256k1");
      teeKey.generateKeys();
      const privateInput = Buffer.from("private local EVM payload");
      const client = createPrimeServerClient({
        baseUrl: `http://127.0.0.1:${rpcAddress.port}/prime/v1`,
        wallet: {
          address: user.address,
          signMessage: ({ message }) => user.signMessage({ message })
        },
        walletClient: userWallet,
        publicClient,
        registryAddress: address,
        chainId: 31337
      });
      const encrypted = await client.prepareEncryptedBlob(privateInput, {
        name: "opaque/private.bin",
        storageMode: "private",
        accessPolicy: "owner_only",
        fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
        expirationSeconds: 3600
      });
      const privateRegistration = await client.registerPaidBlob(encrypted);
      const privateUpload = await client.uploadRegisteredBlob(encrypted, encrypted.ciphertext);
      assert.equal(privateRegistration.policy.storageMode, 1);
      assert.equal(privateUpload.storageMode, "private");
      assert.equal(privateUpload.paymentStatus, "partially_settled");
      const encryptedRead = await client.get(encrypted.name);
      assert.deepEqual(await decryptBlob(encryptedRead.bytes, encrypted.fileKey), privateInput);

      const confidential = await client.prepareEncryptedBlob(Buffer.from("compute-only local payload"), {
        name: "opaque/compute.bin",
        storageMode: "confidential",
        accessPolicy: "compute_only",
        fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
        expirationSeconds: 3600
      });
      await client.registerPaidBlob(confidential);
      await client.uploadRegisteredBlob(confidential, confidential.ciphertext);
      await assert.rejects(
        () => client.get(confidential.name),
        (error) => error?.status === 403
      );
    } finally {
      await close(rpc.server);
      await stopProviderProcesses(suite);
    }
  } finally {
    anvil.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
