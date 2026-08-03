import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { createProviderServer, acknowledgementPayload } from "../src/server.mjs";

async function startProvider() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "prime-server-provider-"));
  const provider = await createProviderServer({ providerId: "provider-test", dataDir });
  await new Promise((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
  const address = provider.server.address();
  return { provider, dataDir, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopProvider(provider) {
  await new Promise((resolve, reject) => provider.server.close((error) => error ? reject(error) : resolve()));
}

test("provider durably stores, signs, serves, and range-reads a shard", async () => {
  const first = await startProvider();
  const bytes = Buffer.from("Prime Server survives provider failure.\n", "utf8");
  const ackContext = `prime-ack-v1|114|registry|blob-test|owner|name|0|commitment|${bytes.length}|provider-test`;

  try {
    const put = await fetch(`${first.baseUrl}/v1/shards/blob-test/0`, {
      method: "PUT",
      headers: { "x-prime-ack-context": ackContext },
      body: bytes
    });
    assert.equal(put.status, 201);
    const receipt = await put.json();
    assert.equal(receipt.providerId, "provider-test");
    assert.equal(receipt.size, bytes.length);
    assert.match(receipt.commitment, /^[0-9a-f]{64}$/);
    assert.equal(receipt.signedPayload, ackContext);

    const publicKey = createPublicKey({ key: Buffer.from(receipt.publicKey, "base64"), type: "spki", format: "der" });
    assert.equal(
      verify(null, Buffer.from(receipt.signedPayload), publicKey, Buffer.from(receipt.signature, "base64")),
      true
    );

    const full = await fetch(`${first.baseUrl}/v1/shards/blob-test/0`);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    const range = await fetch(`${first.baseUrl}/v1/shards/blob-test/0`, {
      headers: { range: "bytes=6-16" }
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "Server surv");
  } finally {
    await stopProvider(first.provider);
  }

  const second = await createProviderServer({ providerId: "provider-test", dataDir: first.dataDir });
  await new Promise((resolve) => second.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = second.server.address();
    const afterRestart = await fetch(`http://127.0.0.1:${address.port}/v1/shards/blob-test/0`);
    assert.equal(afterRestart.status, 200);
    assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), bytes);
  } finally {
    await stopProvider(second);
    await rm(first.dataDir, { recursive: true, force: true });
  }
});

test("acknowledgement payload is deterministic", () => {
  const payload = acknowledgementPayload({
    providerId: "provider-1",
    blobId: "blob-test",
    shardIndex: 2,
    commitment: "abc123",
    size: 42
  });
  assert.equal(payload, "provider-1:blob-test:2:abc123:42");
});
