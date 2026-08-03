import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const providerServerPath = path.join(repositoryRoot, "provider", "src", "server.mjs");
const defaultStatePath = path.join(repositoryRoot, ".prime-server", "provider-processes.json");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const onExit = () => {
      child.off("exit", onExit);
      resolve();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      resolve();
    }
  });
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`provider did not become healthy at ${url}: ${lastError?.message || "timeout"}`);
}

export async function startProviderProcess({ providerId, port, dataDir, logPath }) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, [providerServerPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PRIME_SERVER_PROVIDER_ID: providerId,
      PRIME_SERVER_PROVIDER_PORT: String(port),
      PRIME_SERVER_PROVIDER_DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  const provider = {
    providerId,
    port,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    logPath,
    child,
    logStream
  };
  await waitForHealth(provider.url);
  return provider;
}

export async function startProviderProcesses({
  count = 4,
  basePort = 7101,
  dataRoot = path.join(repositoryRoot, ".prime-server", "providers"),
  logRoot = path.join(repositoryRoot, ".prime-server", "logs")
} = {}) {
  await mkdir(dataRoot, { recursive: true });
  await mkdir(logRoot, { recursive: true });

  const providers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const providerId = `provider-${index + 1}`;
      const port = basePort + index;
      const dataDir = path.join(dataRoot, providerId);
      const logPath = path.join(logRoot, `${providerId}.log`);
      providers.push(await startProviderProcess({ providerId, port, dataDir, logPath }));
    }
  } catch (error) {
    await stopProviderProcesses({ providers });
    throw error;
  }

  return { providers, dataRoot, logRoot };
}

export async function stopProviderProcesses({ providers = [] } = {}) {
  await Promise.all(providers.map(async ({ child, logStream }) => {
    const exited = waitForProcessExit(child);
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill("SIGTERM");
    await exited;
    logStream.end();
  }));
}

async function saveState(statePath, suite) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({
    providers: suite.providers.map(({ providerId, port, dataDir, logPath, child }) => ({
      providerId,
      port,
      dataDir,
      logPath,
      pid: child.pid
    })),
    dataRoot: suite.dataRoot,
    logRoot: suite.logRoot
  }, null, 2)}\n`, { mode: 0o600 });
}

async function startCommand() {
  const suite = await startProviderProcesses();
  await saveState(defaultStatePath, suite);
  console.log(JSON.stringify({
    event: "providers_started",
    statePath: defaultStatePath,
    providers: suite.providers.map(({ providerId, url, pid }) => ({ providerId, url, pid: pid || null }))
  }));

  await new Promise((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await stopProviderProcesses(suite);
      await rm(defaultStatePath, { force: true });
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function stopCommand() {
  const state = JSON.parse(await readFile(defaultStatePath, "utf8"));
  for (const provider of state.providers) {
    try {
      process.kill(provider.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await rm(defaultStatePath, { force: true });
  console.log(JSON.stringify({ event: "providers_stopped", count: state.providers.length }));
}

async function statusCommand() {
  const state = JSON.parse(await readFile(defaultStatePath, "utf8"));
  const providers = await Promise.all(state.providers.map(async (provider) => {
    try {
      const health = await waitForHealth(`http://127.0.0.1:${provider.port}`, 500);
      return { providerId: provider.providerId, status: "ok", health };
    } catch (error) {
      return { providerId: provider.providerId, status: "unavailable", error: error.message };
    }
  }));
  console.log(JSON.stringify({ event: "providers_status", providers }, null, 2));
}

const command = process.argv[2] || "start";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (command === "start") await startCommand();
  else if (command === "stop") await stopCommand();
  else if (command === "status") await statusCommand();
  else throw new Error(`unknown command: ${command}`);
}

export { defaultStatePath, waitForHealth };
