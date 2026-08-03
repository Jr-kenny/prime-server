import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import { createErasureEngine } from "../../provider/src/erasure.mjs";
import { decryptBlob, openDeviceKeyPackage, prepareEncryptedBlob } from "../src/encryption.mjs";
import { canonicalJson } from "../src/policy.mjs";

function openEnvelope(envelope, teeKey) {
  const recipient = createECDH("secp256k1");
  recipient.setPrivateKey(teeKey.getPrivateKey());
  const sharedSecret = recipient.computeSecret(Buffer.from(envelope.ephemeralPublicKey.slice(2), "hex"));
  const wrappingKey = createHash("sha256").update(sharedSecret).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    wrappingKey,
    Buffer.from(envelope.iv.slice(2), "hex")
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag.slice(2), "hex"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext.slice(2), "hex")),
    decipher.final()
  ]).toString("utf8"));
}

test("encrypted preparation stores ciphertext commitment and an FCC-sealed key envelope", async () => {
  const input = Buffer.from("confidential payroll data");
  const teeKey = createECDH("secp256k1");
  teeKey.generateKeys();
  const prepared = await prepareEncryptedBlob(input, {
    name: "opaque/payroll.bin",
    owner: "0x0000000000000000000000000000000000000001",
    fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
    storageMode: "private",
    accessPolicy: "owner_only",
    metadata: { contentType: "application/octet-stream" },
    expirationSeconds: 3600
  });
  const engine = await createErasureEngine();
  const encoded = engine.encode(prepared.ciphertext);

  assert.equal(prepared.size, input.length + 12 + 16);
  assert.equal(prepared.name, `private/${prepared.blobId.slice(2)}`);
  assert.equal(prepared.commitment, `0x${encoded.clayChunksetRoot}`);
  assert.equal(prepared.policy.storageMode, 1);
  assert.equal(prepared.policy.accessPolicy, 0);
  assert.equal(prepared.policy.keyEnvelopeCommitment, prepared.keyEnvelopeCommitment);
  assert.match(prepared.keyEnvelopeCommitment, /^0x[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(prepared.keyEnvelope).includes(prepared.fileKey.toString("hex")), false);
  assert.equal(JSON.stringify(prepared.keyEnvelope).includes("payroll.bin"), false);
  const envelopePayload = openEnvelope(prepared.keyEnvelope, teeKey);
  assert.equal(envelopePayload.metadata.filename, "opaque/payroll.bin");
  assert.equal(envelopePayload.metadata.contentType, "application/octet-stream");
  assert.deepEqual(await decryptBlob(prepared.ciphertext, prepared.fileKey), input);
});

test("canonical JSON preserves and sorts nested metadata", () => {
  const first = canonicalJson({
    outer: { beta: 2, alpha: { z: true, a: "x" } },
    list: [{ two: 2, one: 1 }]
  });
  const second = canonicalJson({
    list: [{ one: 1, two: 2 }],
    outer: { alpha: { a: "x", z: true }, beta: 2 }
  });
  const changed = canonicalJson({
    outer: { beta: 2, alpha: { z: false, a: "x" } },
    list: [{ two: 2, one: 1 }]
  });
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /"alpha":\{"a":"x","z":true\}/);
});

test("a device unwraps an FCC result package without the source file key", async () => {
  const device = createECDH("secp256k1");
  device.generateKeys();
  const ephemeral = createECDH("secp256k1");
  ephemeral.generateKeys();
  const fileKey = randomBytes(32);
  const requestId = `0x${"11".repeat(32)}`;
  const blobId = `0x${"22".repeat(32)}`;
  const deviceKeyCommitment = `0x${createHash("sha256").update(device.getPublicKey()).digest("hex")}`;
  const wrappingKey = createHash("sha256").update(ephemeral.computeSecret(device.getPublicKey())).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  const payload = Buffer.from(canonicalJson({
    requestId,
    blobId,
    deviceKeyCommitment,
    fileKey: `0x${fileKey.toString("hex")}`
  }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const keyPackage = {
    version: 1,
    scheme: "secp256k1-ecies-aes256gcm-device",
    requestId,
    blobId,
    deviceKeyCommitment,
    ephemeralPublicKey: `0x${ephemeral.getPublicKey(undefined, "uncompressed").toString("hex")}`,
    iv: `0x${iv.toString("hex")}`,
    ciphertext: `0x${ciphertext.toString("hex")}`,
    authTag: `0x${cipher.getAuthTag().toString("hex")}`,
    fileKeyCommitment: `0x${createHash("sha256").update(fileKey).digest("hex")}`
  };
  const opened = openDeviceKeyPackage(keyPackage, device.getPrivateKey());
  assert.deepEqual(opened, fileKey);
  opened.fill(0);
  fileKey.fill(0);
});

test("confidential preparation requires compute-only access and FCC public-key material", async () => {
  await assert.rejects(
    () => prepareEncryptedBlob(Buffer.from("secret"), {
      name: "opaque/secret.bin",
      owner: "0x0000000000000000000000000000000000000001",
      storageMode: "confidential",
      accessPolicy: "owner_only"
    }),
    /confidential storage requires compute-only access/
  );

  const teeKey = createECDH("secp256k1");
  teeKey.generateKeys();
  await assert.rejects(
    () => prepareEncryptedBlob(Buffer.from("secret"), {
      name: "opaque/secret.bin",
      owner: "0x0000000000000000000000000000000000000001",
      storageMode: "confidential",
      accessPolicy: "compute_only"
    }),
    /fccPublicKey must be hex bytes/
  );

  const prepared = await prepareEncryptedBlob(Buffer.from("secret"), {
    name: "opaque/secret.bin",
    owner: "0x0000000000000000000000000000000000000001",
    storageMode: "confidential",
    accessPolicy: "compute_only",
    fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`,
    expirationSeconds: 3600
  });
  assert.equal(prepared.policy.storageMode, 2);
  assert.equal(prepared.policy.accessPolicy, 2);
});

test("encrypted preparation requires a source name for sealed metadata", async () => {
  const teeKey = createECDH("secp256k1");
  teeKey.generateKeys();
  await assert.rejects(
    () => prepareEncryptedBlob(Buffer.from("secret"), {
      owner: "0x0000000000000000000000000000000000000001",
      storageMode: "private",
      fccPublicKey: `0x${teeKey.getPublicKey().toString("hex")}`
    }),
    /name is required for encrypted metadata/
  );
});
