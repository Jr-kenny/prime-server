import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createCoston2Chain, createFlareRegistry } from "../src/flare-registry.mjs";

const execFile = promisify(execFileCallback);
const deployerPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function rpcRequest(rpcUrl, method, params = []) {
  return fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  }).then((response) => response.json());
}

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await rpcRequest(rpcUrl, "eth_chainId");
      if (result.result) return;
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

test("Flare registry adapter writes the provider and blob lifecycle to a local EVM", async () => {
  const port = 20_000 + (process.pid % 500);
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
    const deployer = createWalletClient({
      account: privateKeyToAccount(deployerPrivateKey),
      chain,
      transport: http(rpcUrl)
    });
    for (const privateKey of Object.values(providerPrivateKeys)) {
      const account = privateKeyToAccount(privateKey);
      const hash = await deployer.sendTransaction({ to: account.address, value: parseEther("1") });
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

    const registrations = [];
    for (const [providerId] of Object.entries(providerPrivateKeys)) {
      registrations.push(await registry.registerProvider({
        providerId,
        endpoint: `http://127.0.0.1:${7101 + Number(providerId.split("-")[1]) - 1}`,
        signingKey: createHash("sha256").update(providerId).digest("hex")
      }));
    }
    assert.deepEqual(registrations.map((item) => item.providerId), ["1", "2", "3", "4"]);
    const repeatedRegistration = await registry.registerProvider({
      providerId: "provider-1",
      endpoint: "http://127.0.0.1:7101",
      signingKey: createHash("sha256").update("provider-1").digest("hex")
    });
    assert.equal(repeatedRegistration.alreadyRegistered, true);

    const blobId = createHash("sha256").update("local-blob").digest("hex");
    const commitment = createHash("sha256").update("local-root").digest("hex");
    await registry.createBlob({ blobId, commitment, size: 2048, chunkSize: 1024, dataShards: 2, totalShards: 4 });
    for (let index = 0; index < 4; index += 1) {
      await registry.assignShard(blobId, index, `provider-${index + 1}`);
      await registry.acknowledgeShard({
        blobId,
        shardIndex: index,
        providerId: `provider-${index + 1}`,
        commitment: createHash("sha256").update(`shard-${index}`).digest("hex"),
        size: 1024
      });
    }
    await registry.finalizeBlob(blobId);
    const onchain = await registry.getBlob(blobId);
    assert.equal(onchain.acknowledgementCount, 4);
    assert.equal(onchain.status, "active");
    assert.equal(onchain.commitment, commitment);
  } finally {
    anvil.kill("SIGTERM");
  }
});
