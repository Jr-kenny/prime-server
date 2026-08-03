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

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
console.log(new TextDecoder().decode(file.bytes));
```

`prepareBlob` computes the encoding and commitment locally. `registerBlob` sends the direct wallet transaction and requires `publicClient` so it can wait for a successful registration receipt. `uploadRegisteredBlob` sends the original bytes only after that confirmation. The API session is used for access control and rate limiting, while the registry remains the source of ownership.

`prime.put(...)` is a convenience wrapper around the same flow.
