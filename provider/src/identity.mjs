import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IDENTITY_FILE = "identity.json";

export class ProviderIdentity {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.identityPath = path.join(dataDir, IDENTITY_FILE);
    this.privateKey = null;
    this.publicKey = null;
    this.publicKeyDer = null;
    this.fingerprint = null;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const stored = JSON.parse(await readFile(this.identityPath, "utf8"));
      this.privateKey = createPrivateKey(stored.privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;

      const generated = generateKeyPairSync("ed25519");
      this.privateKey = generated.privateKey;
      this.publicKey = generated.publicKey;
      const privateKeyPem = this.privateKey.export({ type: "pkcs8", format: "pem" });
      await writeFile(this.identityPath, JSON.stringify({ privateKeyPem }, null, 2), { mode: 0o600 });
      await chmod(this.identityPath, 0o600);
    }

    this.publicKeyDer = this.publicKey.export({ type: "spki", format: "der" });
    this.fingerprint = createHash("sha256").update(this.publicKeyDer).digest("hex");
    return this;
  }

  signPayload(payload) {
    if (!this.privateKey) throw new Error("provider identity is not loaded");
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    return sign(null, bytes, this.privateKey);
  }

  describe() {
    return {
      publicKey: this.publicKeyDer.toString("base64"),
      fingerprint: this.fingerprint
    };
  }
}

