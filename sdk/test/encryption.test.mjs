import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { createErasureEngine } from "../../provider/src/erasure.mjs";
import { decryptBlob, prepareEncryptedBlob } from "../src/encryption.mjs";

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
  assert.equal(prepared.commitment, `0x${encoded.clayChunksetRoot}`);
  assert.equal(prepared.policy.storageMode, 1);
  assert.equal(prepared.policy.accessPolicy, 0);
  assert.equal(prepared.policy.keyEnvelopeCommitment, prepared.keyEnvelopeCommitment);
  assert.match(prepared.keyEnvelopeCommitment, /^0x[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(prepared.keyEnvelope).includes(prepared.fileKey.toString("hex")), false);
  assert.deepEqual(await decryptBlob(prepared.ciphertext, prepared.fileKey), input);
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
