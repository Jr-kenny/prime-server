import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { PrimeAuthManager } from "../src/auth.mjs";

test("Prime wallet authentication consumes challenges and verifies sessions", async () => {
  const auth = new PrimeAuthManager({ secret: "b".repeat(64), domain: "api.primeserver.example" });
  const account = privateKeyToAccount("0x8b3a350cf5c34c9194ca3a545d8d7ad2b4ad4b9f2f6d7b7c3bb4a8d9e0f1a2b3");
  const challenge = auth.createChallenge(account.address);
  const signature = await account.signMessage({ message: challenge.message });
  const session = await auth.createSession({ address: account.address, nonce: challenge.nonce, signature });

  assert.equal(auth.verifyToken(session.token).address, account.address);
  await assert.rejects(
    () => auth.createSession({ address: account.address, nonce: challenge.nonce, signature }),
    /challenge expired or not found/
  );
  assert.throws(() => auth.verifyToken(`${session.token}tampered`), /invalid authentication token/);
});
