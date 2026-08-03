import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProviderProcess, startProviderProcesses, stopProviderProcesses, waitForProcessExit } from "../../scripts/providers.mjs";
import { createCoston2Chain, createFlareRegistry } from "../src/flare-registry.mjs";
import { createPrimeRpcServer } from "../src/server.mjs";
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
    const rpc = await createPrimeRpcServer({ providers: suite.providers, registry });
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
    } finally {
      await close(rpc.server);
      await stopProviderProcesses(suite);
    }
  } finally {
    anvil.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
