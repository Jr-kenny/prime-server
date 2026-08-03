import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrimeServerClient } from "../src/client.mjs";
import { createErasureEngine } from "../../provider/src/erasure.mjs";

const address = "0x0000000000000000000000000000000000000001";

test("SDK prepares the same commitment as the provider engine and uploads a registered blob", async () => {
  const input = Buffer.alloc(2 * 1024 * 1024, 7);
  const providerEngine = await createErasureEngine();
  const providerEncoding = providerEngine.encode(input);
  const writes = [];
  const requests = [];
  const wallet = {
    address,
    async signMessage() {
      return "0xsignature";
    }
  };
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet,
    registryAddress: "0x0000000000000000000000000000000000000002",
    walletClient: {
      account: { address },
      async writeContract(request) {
        writes.push(request);
        return "0xregistration";
      }
    },
    publicClient: {
      async waitForTransactionReceipt({ hash }) {
        return { status: "success", hash };
      }
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.includes("/auth/challenge")) {
        return new Response(JSON.stringify({ nonce: "nonce", message: "sign this" }), { status: 200 });
      }
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ token: "session-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ blobId: "0xblob", status: "active" }), { status: 201 });
    }
  });

  const prepared = await client.prepareBlob(input, { name: "agent/memory.json", expirationSeconds: 3600 });
  assert.equal(prepared.size, input.length);
  assert.equal(prepared.commitment, `0x${providerEncoding.clayChunksetRoot}`);
  assert.equal(prepared.chunkSize, providerEngine.config.chunkSizeBytes);
  assert.equal(prepared.totalShards, providerEngine.config.n);

  const registration = await client.registerBlob(prepared);
  assert.equal(registration.hash, "0xregistration");
  assert.equal(registration.receipt.status, "success");
  assert.equal(writes[0].functionName, "createBlobNamed");
  assert.deepEqual(writes[0].args, [
    prepared.blobId,
    prepared.name,
    prepared.commitment,
    BigInt(prepared.size),
    prepared.chunkSize,
    prepared.dataShards,
    prepared.totalShards,
    BigInt(prepared.expiresAt)
  ]);

  const uploaded = await client.uploadRegisteredBlob(prepared, input, { contentType: "application/json" });
  assert.equal(uploaded.status, "active");
  const uploadRequest = requests.find(({ init }) => init.method === "PUT");
  assert.equal(uploadRequest.init.headers.get("x-prime-blob-id"), prepared.blobId);
  assert.equal(uploadRequest.init.headers.get("x-prime-commitment"), prepared.commitment);
  assert.equal(Buffer.from(uploadRequest.init.body).length, input.length);
  assert.match(uploadRequest.init.headers.get("authorization"), /^Bearer session-token$/);
});

test("SDK requires a public client before registering a blob", async () => {
  const input = Buffer.from("registration must be confirmed");
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet: { address },
    registryAddress: "0x0000000000000000000000000000000000000002",
    walletClient: {
      account: { address },
      async writeContract() {
        return "0xregistration";
      }
    },
    fetchImpl: async () => new Response("unexpected request", { status: 500 })
  });

  const prepared = await client.prepareBlob(input, { name: "agent/memory.json", expirationSeconds: 3600 });
  await assert.rejects(
    () => client.registerBlob(prepared),
    /publicClient is required to confirm blob registration before upload/
  );
});
