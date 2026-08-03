import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProviderProcesses, stopProviderProcesses, waitForHealth, waitForProcessExit } from "../scripts/providers.mjs";

test("provider harness runs four isolated processes and detects shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prime-server-harness-"));
  const suite = await startProviderProcesses({
    basePort: 18_000 + (process.pid % 500),
    dataRoot: path.join(root, "providers"),
    logRoot: path.join(root, "logs")
  });

  try {
    assert.equal(suite.providers.length, 4);
    const health = await Promise.all(suite.providers.map((provider) => waitForHealth(provider.url)));
    assert.deepEqual(health.map((item) => item.status), ["ok", "ok", "ok", "ok"]);
    assert.notEqual(suite.providers[0].dataDir, suite.providers[1].dataDir);
    assert.notEqual(suite.providers[0].port, suite.providers[1].port);

    const stopped = [suite.providers[1], suite.providers[3]];
    const stoppedExits = stopped.map((provider) => waitForProcessExit(provider.child));
    for (const provider of stopped) provider.child.kill("SIGTERM");
    await Promise.all(stoppedExits);
    for (const provider of stopped) {
      await assert.rejects(waitForHealth(provider.url, 500), /provider did not become healthy/);
    }

    const surviving = await Promise.all(
      suite.providers.filter((provider) => !stopped.includes(provider)).map((provider) => waitForHealth(provider.url))
    );
    assert.equal(surviving.length, 2);
    assert.deepEqual(surviving.map((item) => item.status), ["ok", "ok"]);
  } finally {
    await stopProviderProcesses(suite);
    await rm(root, { recursive: true, force: true });
  }
});
