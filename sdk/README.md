# Prime Server SDK

The SDK gives applications a registration-first blob interface over the Prime Server developer API.

```js
import { PrimeServerClient } from "@prime-server/sdk";

const prime = new PrimeServerClient({
  baseUrl: "https://api.primeserver.example/prime/v1",
  wallet: {
    address: walletAddress,
    signMessage: ({ message }) => walletClient.signMessage({ message })
  },
  walletClient,
  publicClient,
  registryAddress: "0xRegistryAddress"
});

const bytes = Buffer.from("hello");
const prepared = await prime.prepareBlob(bytes, {
  name: "reports/hello.txt",
  expirationSeconds: 86_400
});
await prime.registerBlob(prepared);
await prime.uploadRegisteredBlob(prepared, bytes, { contentType: "text/plain" });

const paid = await prime.prepareBlob(bytes, {
  name: "reports/paid.txt",
  expirationSeconds: 86_400
});
await prime.registerPaidBlob(paid, {
  storageMode: "public",
  accessPolicy: "owner_only"
});
await prime.uploadRegisteredBlob(paid, bytes, { contentType: "text/plain" });

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
console.log(new TextDecoder().decode(file.bytes));
```

`prepareBlob` computes the encoding and commitment locally. `registerBlob` sends an unpaid direct wallet transaction. `registerPaidBlob` reads the native quote and sends payment plus registration in one wallet transaction. Both methods require `publicClient` so they can wait for a successful registration receipt. `uploadRegisteredBlob` sends bytes only after that confirmation. The API session is used for access control and rate limiting, while the registry remains the source of ownership.

For private storage, call `prepareEncryptedBlob` with the FCC public key. It returns `ciphertext`, an FCC-sealed `keyEnvelope`, and policy commitments. Keep `fileKey` in memory only. Upload `encrypted.ciphertext` through the paid registration flow. The provider and RPC never receive the plaintext file key.

For confidential access, call `createDeviceKeyPair`, then `prepareConfidentialAccessRequest` and `authorizeConfidentialAccess`. The signed request binds the wallet, blob, device-key commitment, purpose, deadline, and onchain nonce.

`prime.put(...)` is a convenience wrapper around the same flow.
