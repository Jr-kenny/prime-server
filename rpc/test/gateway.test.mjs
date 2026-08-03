import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { PrimeAuthManager } from "../src/auth.mjs";
import { MemoryRegistry } from "../src/memory-registry.mjs";
import { JsonOperationalStore } from "../src/operational-store.mjs";
import { createPrimeRpcServer } from "../src/server.mjs";
import { startProviderProcesses, stopProviderProcesses } from "../../scripts/providers.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("wallet-owned developer API supports put, list, head, get, and range reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-gateway-"));
  const suite = await startProviderProcesses({
    basePort: 21_000 + (process.pid % 500),
    dataRoot: path.join(root, "providers"),
    logRoot: path.join(root, "logs")
  });
  const registry = new MemoryRegistry();
  const objectStore = new JsonOperationalStore(path.join(root, "operational-state.json"));
  const authManager = new PrimeAuthManager({ secret: "a".repeat(64), domain: "api.primeserver.example" });
  const account = privateKeyToAccount("0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a7c03b4b9e9b6b9e4e1");
  let rpc;
  try {
    rpc = await createPrimeRpcServer({
      providers: suite.providers,
      registry,
      objectStore,
      authManager,
      publicBaseUrl: "https://api.primeserver.example/prime/v1"
    });
    const baseUrl = await listen(rpc.server);
    const preflight = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    const unauthorized = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`);
    assert.equal(unauthorized.status, 401);

    const challenge = await (await fetch(`${baseUrl}/prime/v1/auth/challenge?address=${account.address}`)).json();
    const signature = await account.signMessage({ message: challenge.message });
    const session = await (await fetch(`${baseUrl}/prime/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address, nonce: challenge.nonce, signature })
    })).json();
    const authorization = { authorization: `Bearer ${session.token}` };

    const input = Buffer.alloc(2 * 1024 * 1024);
    input[0] = 0x50;
    input[input.length - 1] = 0x53;
    const put = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "PUT",
      headers: {
        ...authorization,
        "content-type": "text/plain",
        "x-prime-expiration-seconds": "3600"
      },
      body: input
    });
    const putBody = await put.text();
    assert.equal(put.status, 201, putBody);
    const metadata = JSON.parse(putBody);
    assert.equal(metadata.account, account.address);
    assert.equal(metadata.name, "hello.txt");
    assert.match(metadata.nameHash, /^[a-f0-9]{64}$/);
    assert.equal(metadata.status, "active");
    assert.match(metadata.downloadUrl, /^https:\/\/api\.primeserver\.example\/prime\/v1/);
    assert.equal(registry.getBlob(metadata.blobId).blobName, "hello.txt");

    const listing = await (await fetch(`${baseUrl}/prime/v1/blobs/${account.address}`, { headers: authorization })).json();
    assert.deepEqual(listing.objects.map((object) => object.name), ["hello.txt"]);

    const head = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "HEAD",
      headers: authorization
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/plain");
    assert.equal(Number(head.headers.get("content-length")), input.length);

    const range = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      headers: { ...authorization, range: "bytes=0-99" }
    });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), input.subarray(0, 100));

    const duplicate = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "PUT",
      headers: { ...authorization, "x-prime-expiration-seconds": "3600" },
      body: input
    });
    assert.equal(duplicate.status, 409);
  } finally {
    if (rpc) await close(rpc.server);
    await stopProviderProcesses(suite);
    await rm(root, { recursive: true, force: true });
  }
});
