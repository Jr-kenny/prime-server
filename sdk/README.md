# Prime Server SDK

The SDK gives applications a wallet-owned blob interface over the Prime Server developer API.

```js
import { PrimeServerClient } from "@prime-server/sdk";

const prime = new PrimeServerClient({
  baseUrl: "https://api.primeserver.example/prime/v1",
  wallet: {
    address: walletAddress,
    signMessage: ({ message }) => walletClient.signMessage({ message })
  }
});

await prime.put("reports/hello.txt", Buffer.from("hello"), {
  expirationSeconds: 86_400,
  contentType: "text/plain"
});

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/hello.txt");
console.log(new TextDecoder().decode(file.bytes));
```

The client authenticates with a wallet signature. The gateway records the wallet as the blob owner on Flare and keeps provider placement, erasure coding, acknowledgements, and recovery behind the API.
