import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProviderProcesses, stopProviderProcesses, waitForProcessExit } from "../../scripts/providers.mjs";
import { MemoryRegistry } from "../src/memory-registry.mjs";
import { createPrimeRpcServer } from "../src/server.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Prime RPC uploads a real blob to four providers and verifies acknowledgements", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-rpc-"));
  const suite = await startProviderProcesses({
    basePort: 19_000 + (process.pid % 500),
    dataRoot: path.join(root, "providers"),
    logRoot: path.join(root, "logs")
  });
  const registry = new MemoryRegistry();
  const rpc = await createPrimeRpcServer({ providers: suite.providers, registry });
  const baseUrl = await listen(rpc.server);
  const input = Buffer.alloc(2 * 1024 * 1024);
  for (let index = 0; index < input.length; index += 1) input[index] = (index * 29 + 11) % 256;

  try {
    const response = await fetch(`${baseUrl}/v1/blobs`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: input
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.status, "active");
    assert.equal(result.providers.length, 4);
    assert.equal(result.registry.acknowledgements.length, 4);
    assert.equal(result.registry.placement["0"], "provider-1");
    assert.equal(result.registry.placement["3"], "provider-4");

    for (const provider of suite.providers) {
      const shardIndex = Number(provider.providerId.split("-")[1]) - 1;
      const shard = await fetch(`${provider.url}/v1/shards/${result.blobId}/${shardIndex}`);
      assert.equal(shard.status, 200);
      assert.equal((await shard.arrayBuffer()).byteLength, 1024 * 1024);
    }

    assert.equal(hash(input).length, 64);

    const stopped = [suite.providers[1], suite.providers[3]];
    const stoppedExits = stopped.map((provider) => waitForProcessExit(provider.child));
    for (const provider of stopped) provider.child.kill("SIGTERM");
    await Promise.all(stoppedExits);

    const recovered = await fetch(`${baseUrl}/v1/blobs/${result.blobId}/content`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("x-prime-recovered"), "true");
    assert.equal(recovered.headers.get("x-prime-missing-shards"), "1,3");
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), input);

    const range = await fetch(`${baseUrl}/v1/blobs/${result.blobId}/content`, {
      headers: { range: "bytes=100-999" }
    });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), input.subarray(100, 1000));
  } finally {
    await close(rpc.server);
    await stopProviderProcesses(suite);
    await rm(root, { recursive: true, force: true });
  }
});
