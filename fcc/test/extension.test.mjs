import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { encodeAbiParameters } from "viem";
import { createDeviceKeyPair, prepareEncryptedBlob } from "../../sdk/src/encryption.mjs";
import { canonicalJson as sdkCanonicalJson } from "../../sdk/src/policy.mjs";
import {
  CONFIDENTIAL_COMPUTE_TYPES,
  KEY_REWRAP_TYPES,
  OP_COMMAND_CONFIDENTIAL_COMPUTE,
  OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME,
  OP_COMMAND_KEY_REWRAP,
  OP_COMMAND_KEY_REWRAP_NAME,
  OP_TYPE_PRIME_SERVER
} from "../src/config.mjs";
import { register } from "../src/fce-adapter.mjs";
import { handleAction } from "../src/handler.mjs";
import {
  canonicalJson,
  openDeviceKeyPackage,
  sha256Hex
} from "../src/crypto.mjs";

function encodeEnvelope(envelope) {
  return `0x${Buffer.from(sdkCanonicalJson(envelope), "utf8").toString("hex")}`;
}

function decodeResult(data) {
  return JSON.parse(Buffer.from(data.slice(2), "hex").toString("utf8"));
}

function teeKeyPair() {
  const key = createECDH("secp256k1");
  key.generateKeys();
  return key;
}

test("FCE adapter registers the two Prime Server operation routes", () => {
  const routes = new Map();
  register({
    handle(opType, opCommand, handler) {
      routes.set(`${opType}/${opCommand}`, handler);
    }
  }, { teePrivateKey: Buffer.alloc(32, 1), retrieveCiphertext: async () => Buffer.alloc(0) });
  assert.equal(routes.size, 2);
  assert.equal(routes.has(`PRIME_SERVER/${OP_COMMAND_KEY_REWRAP_NAME}`), true);
  assert.equal(routes.has(`PRIME_SERVER/${OP_COMMAND_CONFIDENTIAL_COMPUTE_NAME}`), true);
});

test("FCC key rewrap returns a device-bound package that a second device can open", async () => {
  const teeKey = teeKeyPair();
  const owner = "0x0000000000000000000000000000000000000001";
  const requester = "0x0000000000000000000000000000000000000009";
  const prepared = await prepareEncryptedBlob(Buffer.from("same wallet, new device"), {
    name: "photos/identity.png",
    owner,
    storageMode: "private",
    accessPolicy: "owner_only",
    fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
    expirationSeconds: 3600
  });
  const device = createDeviceKeyPair();
  const requestId = `0x${"11".repeat(32)}`;
  const envelopeBytes = encodeEnvelope(prepared.keyEnvelope);
  const message = encodeAbiParameters(KEY_REWRAP_TYPES, [
    requestId,
    prepared.blobId,
    owner,
    requester,
    device.keyCommitment,
    prepared.keyEnvelopeCommitment,
    device.publicKey,
    envelopeBytes
  ]);

  const [data, status, error] = await handleAction({
    opType: OP_TYPE_PRIME_SERVER,
    opCommand: OP_COMMAND_KEY_REWRAP,
    message,
    teePrivateKey: teeKey.getPrivateKey()
  });
  assert.equal(status, 1, error);
  assert.equal(error, null);
  const keyPackage = decodeResult(data);
  const opened = openDeviceKeyPackage(keyPackage, device.privateKey);
  assert.deepEqual(opened.fileKey, prepared.fileKey);
  assert.equal(keyPackage.requestId, requestId);
  assert.equal(keyPackage.blobId, prepared.blobId);
  assert.equal(JSON.stringify(keyPackage).includes(prepared.fileKey.toString("hex")), false);
});

test("FCC compute decrypts inside the handler and returns only the approved result", async () => {
  const teeKey = teeKeyPair();
  const owner = "0x0000000000000000000000000000000000000002";
  const plaintext = Buffer.from(JSON.stringify({ records: [{ amount: 4 }, { amount: 9 }, { amount: 12 }] }));
  const prepared = await prepareEncryptedBlob(plaintext, {
    name: "payroll.json",
    owner,
    storageMode: "confidential",
    accessPolicy: "compute_only",
    fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
    expirationSeconds: 3600
  });
  const requestId = `0x${"22".repeat(32)}`;
  const envelopeBytes = encodeEnvelope(prepared.keyEnvelope);
  const computeSpec = `0x${Buffer.from(JSON.stringify({ operation: "json_field_sum", field: "amount" }), "utf8").toString("hex")}`;
  const inputCommitment = sha256Hex(prepared.ciphertext);
  const message = encodeAbiParameters(CONFIDENTIAL_COMPUTE_TYPES, [
    requestId,
    prepared.blobId,
    owner,
    owner,
    prepared.keyEnvelopeCommitment,
    envelopeBytes,
    computeSpec,
    inputCommitment
  ]);

  const [data, status, error] = await handleAction({
    opType: OP_TYPE_PRIME_SERVER,
    opCommand: OP_COMMAND_CONFIDENTIAL_COMPUTE,
    message,
    teePrivateKey: teeKey.getPrivateKey(),
    retrieveCiphertext: async (blobId) => {
      assert.equal(blobId, prepared.blobId);
      return prepared.ciphertext;
    }
  });
  assert.equal(status, 1, error);
  assert.equal(error, null);
  const response = decodeResult(data);
  assert.equal(response.result.sum, 25);
  assert.equal(JSON.stringify(response).includes(plaintext.toString("utf8")), false);
  assert.match(response.responseCommitment, /^0x[a-f0-9]{64}$/);
  assert.equal(response.responseCommitment, sha256Hex(Buffer.from(canonicalJson({
    version: 1,
    requestId,
    blobId: prepared.blobId,
    operation: "json_field_sum",
    result: { sum: 25 }
  }))));
});

test("FCC rejects a tampered key-envelope commitment before opening it", async () => {
  const teeKey = teeKeyPair();
  const message = encodeAbiParameters(KEY_REWRAP_TYPES, [
    `0x${"33".repeat(32)}`,
    `0x${"44".repeat(32)}`,
    "0x0000000000000000000000000000000000000003",
    "0x0000000000000000000000000000000000000003",
    `0x${"55".repeat(32)}`,
    `0x${"66".repeat(32)}`,
    `0x04${"11".repeat(64)}`,
    `0x${Buffer.from("{}").toString("hex")}`
  ]);
  const [data, status, error] = await handleAction({
    opType: OP_TYPE_PRIME_SERVER,
    opCommand: OP_COMMAND_KEY_REWRAP,
    message,
    teePrivateKey: teeKey.getPrivateKey()
  });
  assert.equal(data, null);
  assert.equal(status, 0);
  assert.match(error, /envelope commitment mismatch/);
});
