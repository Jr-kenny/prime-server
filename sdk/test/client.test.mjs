import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    chainId: 31337,
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

test("SDK quotes and atomically registers a paid blob with its policy", async () => {
  const input = Buffer.from("paid Prime Server object");
  const writes = [];
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet: {
      address,
      async signMessage() {
        return "0xsignature";
      }
    },
    registryAddress: "0x0000000000000000000000000000000000000002",
    walletClient: {
      account: { address },
      async writeContract(request) {
        writes.push(request);
        return "0xpaid-registration";
      }
    },
    publicClient: {
      async readContract() {
        return {
          total: 8400n,
          providerPool: 8000n,
          protocolFee: 400n,
          providerRewardPerShard: 2000n,
          quoteCommitment: `0x${"11".repeat(32)}`
        };
      },
      async waitForTransactionReceipt({ hash }) {
        return { status: "success", hash };
      }
    },
    fetchImpl: async (url, init = {}) => {
      if (url.includes("/auth/challenge")) {
        return new Response(JSON.stringify({ nonce: "nonce", message: "sign this" }), { status: 200 });
      }
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ token: "session-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ blobId: "0xpaid", status: "active" }), { status: 201 });
    }
  });

  const prepared = await client.prepareBlob(input, { name: "paid/report.json", expirationSeconds: 3600 });
  const registration = await client.registerPaidBlob(prepared, { storageMode: "public", accessPolicy: "owner_only" });
  assert.equal(registration.hash, "0xpaid-registration");
  assert.equal(registration.payment.status, "escrowed");
  assert.equal(writes[0].functionName, "createBlobNamedPaid");
  assert.equal(writes[0].value, 8400n);
  assert.equal(writes[0].args[0].blobId, prepared.blobId);
  assert.equal(writes[0].args[0].storageMode, 0);
  assert.equal(writes[0].args[0].accessPolicy, 0);
  assert.match(writes[0].args[0].policyCommitment, /^0x[a-f0-9]{64}$/);
  assert.equal(writes[0].args[0].keyEnvelopeCommitment, `0x${"00".repeat(32)}`);

  const uploaded = await client.uploadRegisteredBlob(prepared, input, { contentType: "application/json" });
  assert.equal(uploaded.status, "active");

  const privatePrepared = await client.prepareBlob(input, { name: "private/report.json", expirationSeconds: 3600 });
  await assert.rejects(
    () => client.registerPaidBlob(privatePrepared, { storageMode: "private" }),
    /key envelope commitment/
  );
});

test("SDK binds a fresh device key to a replay-protected confidential access intent", async () => {
  const writes = [];
  const signature = `0x${"12".repeat(65)}`;
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet: { address },
    registryAddress: "0x0000000000000000000000000000000000000002",
    chainId: 31337,
    walletClient: {
      account: { address },
      async signTypedData(request) {
        assert.equal(request.primaryType, "ConfidentialAccess");
        return signature;
      },
      async writeContract(request) {
        writes.push(request);
        return "0xaccess-authorization";
      }
    },
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === "confidentialAccessNonces") return 0n;
        if (functionName === "hashConfidentialAccess") return `0x${"34".repeat(32)}`;
        throw new Error(`unexpected read ${functionName}`);
      },
      async waitForTransactionReceipt({ hash }) {
        return { status: "success", hash };
      }
    },
    fetchImpl: async () => new Response("unexpected request", { status: 500 })
  });

  const device = client.createDeviceKeyPair();
  const prepared = await client.prepareConfidentialAccessRequest({
    blobId: `0x${"56".repeat(32)}`,
    devicePublicKey: device.publicKey,
    purpose: "compute"
  });
  assert.equal(prepared.request.requester, address);
  assert.equal(prepared.request.deviceKeyCommitment, device.keyCommitment);
  assert.equal(prepared.request.purpose, 1);
  assert.equal(prepared.request.nonce, 0n);

  const authorized = await client.authorizeConfidentialAccess(prepared);
  assert.equal(authorized.requestId, `0x${"34".repeat(32)}`);
  assert.equal(writes[0].functionName, "authorizeConfidentialAccess");
  assert.equal(writes[0].args[1], signature);
});

test("SDK requests, waits for, and submits a signed confidential compute result", async () => {
  const writes = [];
  const requests = [];
  const blobId = `0x${"12".repeat(32)}`;
  const requestId = `0x${"34".repeat(32)}`;
  const instructionId = `0x${"56".repeat(32)}`;
  const senderAddress = "0x0000000000000000000000000000000000000010";
  const verifierAddress = "0x0000000000000000000000000000000000000011";
  const signature = `0x${"ab".repeat(65)}`;
  const actionResult = {
    id: instructionId,
    status: 1,
    submissionTag: "COMPUTE",
    data: `0x${Buffer.from(JSON.stringify({
      blobId,
      operation: "json_field_sum",
      requestId,
      result: { field: "amount", sum: 25 },
      version: 1
    })).toString("hex")}`
  };
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet: { address },
    token: "session-token",
    registryAddress: "0x0000000000000000000000000000000000000002",
    chainId: 31337,
    walletClient: {
      account: { address },
      async signTypedData(request) {
        assert.equal(request.primaryType, "ConfidentialAccess");
        return signature;
      },
      async writeContract(request) {
        writes.push(request);
        return request.functionName === "requestConfidentialCompute" ? "0xfcc-request" : `${request.functionName}-tx`;
      }
    },
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === "confidentialAccessNonces") return 0n;
        if (functionName === "hashConfidentialAccess") return requestId;
        throw new Error(`unexpected read ${functionName}`);
      },
      async waitForTransactionReceipt({ hash }) {
        if (hash === "0xfcc-request") {
          return {
            status: "success",
            logs: [{
              address: senderAddress,
              topics: ["0xevent", requestId, blobId, instructionId]
            }]
          };
        }
        return { status: "success", hash };
      }
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith(`/fcc/result/${instructionId}`)) {
        return new Response(JSON.stringify({ result: actionResult, signature }), { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    }
  });

  const result = await client.confidentialCompute({
    prepared: {
      blobId,
      keyEnvelope: { blobId, version: 1 },
      ciphertext: Buffer.from("encrypted ciphertext")
    },
    senderAddress,
    verifierAddress,
    operation: "json_field_sum",
    field: "amount",
    instructionFee: 123n
  });

  assert.equal(result.requestId, requestId);
  assert.equal(result.instructionId, instructionId);
  assert.deepEqual(result.result.result, { field: "amount", sum: 25 });
  assert.equal(writes.map((request) => request.functionName).join(","), "authorizeConfidentialAccess,requestConfidentialCompute,submitResult");
  assert.equal(writes[1].value, 123n);
  assert.equal(writes[1].args[0], requestId);
  assert.equal(writes[1].args[3], `0x${createHash("sha256").update("encrypted ciphertext").digest("hex")}`);
  assert.equal(writes[2].args[2], instructionId);
  assert.equal(requests[0].init.headers.authorization, "Bearer session-token");
});

test("SDK can retrieve ciphertext for a selected wallet through an owner-scoped route", async () => {
  const requests = [];
  const selectedWallet = "0x0000000000000000000000000000000000000003";
  const owner = "0x0000000000000000000000000000000000000004";
  const accessRequestId = `0x${"ab".repeat(32)}`;
  const client = createPrimeServerClient({
    baseUrl: "https://api.primeserver.example/prime/v1",
    wallet: { address: selectedWallet },
    token: "session-token",
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      return new Response(Buffer.from("ciphertext"), {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-prime-blob-id": `0x${"12".repeat(32)}` }
      });
    }
  });

  const result = await client.get("private/blob", { account: owner, accessRequestId });
  assert.equal(result.bytes.length, 10);
  assert.equal(requests[0].url, `${client.baseUrl}/blobs/${owner}/private%2Fblob`);
  assert.equal(requests[0].init.headers.get("x-prime-access-request-id"), accessRequestId);
});
