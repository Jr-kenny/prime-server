import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createCoston2Chain, createFlareRegistry } from "../src/flare-registry.mjs";
import { PrimeServerEventIndexer } from "../src/event-indexer.mjs";

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

test("event indexer resumes from a block cursor and parses Prime Server events", async () => {
  const port = 23_000 + (process.pid % 500);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
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
    const registry = createFlareRegistry({ address, rpcUrl, chainId: 31337, deployerPrivateKey, providerPrivateKeys });
    for (const [providerId] of Object.entries(providerPrivateKeys)) {
      await registry.registerProvider({
        providerId,
        endpoint: `http://127.0.0.1:${7101 + Number(providerId.split("-")[1]) - 1}`,
        signingKey: createHash("sha256").update(providerId).digest("hex")
      });
    }
    const blobId = createHash("sha256").update("indexer-blob").digest("hex");
    await registry.createBlobNamed({
      blobId,
      blobName: "indexer/test.bin",
      commitment: createHash("sha256").update("indexer-root").digest("hex"),
      size: 2048,
      chunkSize: 1024,
      dataShards: 2,
      totalShards: 4,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600
    });
    for (let index = 0; index < 4; index += 1) await registry.assignShard(blobId, index, `provider-${index + 1}`);

    const indexer = new PrimeServerEventIndexer({ publicClient, address, fromBlock: 1n, maxBlockRange: 3n });
    const first = await indexer.poll();
    assert.equal(first.filter((event) => event.eventName === "ProviderRegistered").length, 4);
    assert.equal(first.filter((event) => event.eventName === "BlobCreated").length, 1);
    assert.equal(first.filter((event) => event.eventName === "BlobNamed").length, 1);
    assert.equal(first.filter((event) => event.eventName === "ShardAssigned").length, 4);
    const cursor = indexer.nextBlock;
    const second = await indexer.poll();
    assert.equal(second.length, 0);
    assert.equal(indexer.nextBlock, cursor);
    assert.equal(indexer.snapshot().events.length, 10);
  } finally {
    anvil.kill("SIGTERM");
  }
});
