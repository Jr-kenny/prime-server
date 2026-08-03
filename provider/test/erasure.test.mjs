import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createErasureEngine } from "../src/erasure.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("four-provider Clay coding recovers two missing shards", async () => {
  const config = { n: 4, k: 2, d: 3, chunkSizeBytes: 1024 * 1024 };
  const engine = await createErasureEngine(config);
  const input = Buffer.alloc(config.k * config.chunkSizeBytes);
  for (let index = 0; index < input.length; index += 1) input[index] = (index * 17 + 23) % 256;

  const encoded = engine.encode(input);
  assert.equal(encoded.chunks.length, 4);
  assert.equal(encoded.chunkCommitments.length, 4);
  assert.equal(encoded.clayChunkRoots.length, 4);

  const recovered = await engine.decode(
    [
      { index: 1, bytes: encoded.chunks[1] },
      { index: 2, bytes: encoded.chunks[2] }
    ],
    [0, 3],
    input.length
  );

  assert.equal(hash(recovered.recovered), hash(input));
  assert.deepEqual(recovered.chunks.map(hash), encoded.chunks.map(hash));
  assert.equal(recovered.clayChunksetRoot, encoded.clayChunksetRoot);
});

test("erasure engine rejects fewer than the required surviving shards", async () => {
  const engine = await createErasureEngine({ n: 4, k: 2, d: 3, chunkSizeBytes: 1024 * 1024 });
  await assert.rejects(
    engine.decode([{ index: 0, bytes: Buffer.alloc(1024 * 1024) }], [1, 2, 3], 1024 * 1024),
    /expected 1 available chunks|at least 2 chunks/
  );
});
