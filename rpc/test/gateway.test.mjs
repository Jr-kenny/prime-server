import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PrimeAuthManager } from "../src/auth.mjs";
import { MemoryRegistry } from "../src/memory-registry.mjs";
import { JsonOperationalStore } from "../src/operational-store.mjs";
import { createPrimeRpcServer } from "../src/server.mjs";
import { createErasureEngine } from "../../provider/src/erasure.mjs";
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
    const rawPut = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "text/plain" },
      body: input
    });
    assert.equal(rawPut.status, 400);
    const erasureEngine = await createErasureEngine();
    const encoded = erasureEngine.encode(input);
    const blobId = createHash("sha256").update("gateway-user-registration").digest("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await registry.createBlobNamed({
      blobId,
      blobName: "hello.txt",
      owner: account.address,
      commitment: encoded.clayChunksetRoot,
      size: input.length,
      chunkSize: erasureEngine.config.chunkSizeBytes,
      dataShards: erasureEngine.config.k,
      totalShards: erasureEngine.config.n,
      expiresAt
    });
    const mismatchedCommitment = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "PUT",
      headers: {
        ...authorization,
        "content-type": "text/plain",
        "x-prime-blob-id": blobId,
        "x-prime-commitment": `0x${"00".repeat(32)}`,
        "x-prime-expires-at": String(expiresAt)
      },
      body: input
    });
    assert.equal(mismatchedCommitment.status, 400);
    const put = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      method: "PUT",
      headers: {
        ...authorization,
        "content-type": "text/plain",
        "x-prime-blob-id": blobId,
        "x-prime-commitment": encoded.clayChunksetRoot,
        "x-prime-chunk-size": String(erasureEngine.config.chunkSizeBytes),
        "x-prime-data-shards": String(erasureEngine.config.k),
        "x-prime-total-shards": String(erasureEngine.config.n),
        "x-prime-expires-at": String(expiresAt)
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
    assert.equal(metadata.origin, "user");
    assert.match(metadata.downloadUrl, /^https:\/\/api\.primeserver\.example\/prime\/v1/);
    assert.equal(registry.getBlob(metadata.blobId).blobName, "hello.txt");
    assert.equal(registry.getBlob(metadata.blobId).owner, account.address);

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
      headers: { ...authorization, "x-prime-blob-id": blobId },
      body: input
    });
    assert.equal(duplicate.status, 409);

    const selectedWallet = privateKeyToAccount(generatePrivateKey());
    const selectedChallenge = await (await fetch(`${baseUrl}/prime/v1/auth/challenge?address=${selectedWallet.address}`)).json();
    const selectedSignature = await selectedWallet.signMessage({ message: selectedChallenge.message });
    const selectedSession = await (await fetch(`${baseUrl}/prime/v1/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: selectedWallet.address, nonce: selectedChallenge.nonce, signature: selectedSignature })
    })).json();
    const selectedObject = await objectStore.getObject(account.address, "hello.txt");
    await objectStore.putObject({ ...selectedObject, accessPolicy: "selected_wallets" });
    const selectedBlob = registry.getBlob(metadata.blobId);
    selectedBlob.policy.accessPolicy = 1;
    selectedBlob.policy.accessPolicyName = "selected_wallets";
    await registry.setBlobWalletAccess({ blobId: metadata.blobId, wallet: selectedWallet.address, allowed: true });
    const accessRequestId = "ab".repeat(32);
    registry.seedConfidentialAccessRequest({
      requestId: accessRequestId,
      blobId: metadata.blobId,
      requester: selectedWallet.address,
      purpose: 0,
      deadline: Math.floor(Date.now() / 1000) + 3600
    });
    const selectedGet = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      headers: {
        authorization: `Bearer ${selectedSession.token}`,
        "x-prime-access-request-id": `0x${accessRequestId}`
      }
    });
    assert.equal(selectedGet.status, 200);
    assert.deepEqual(Buffer.from(await selectedGet.arrayBuffer()), input);
    const missingAccessRequest = await fetch(`${baseUrl}/prime/v1/blobs/${account.address}/hello.txt`, {
      headers: { authorization: `Bearer ${selectedSession.token}` }
    });
    assert.equal(missingAccessRequest.status, 403);
  } finally {
    if (rpc) await close(rpc.server);
    await stopProviderProcesses(suite);
    await rm(root, { recursive: true, force: true });
  }
});
