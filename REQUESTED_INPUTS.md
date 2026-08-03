# Prime Server Requested Inputs

This file is the handoff list for anything that must come from the user or the local environment. Secrets should be placed in local files or a secret manager. They should never be pasted into chat or committed to Git.

## Needed for local implementation

- Node.js and a package manager. The implementation can use the existing Mac toolchain if it passes the version checks.
- Foundry. The current contract scaffold already builds with the installed Foundry toolchain.
- A running Docker daemon if we choose containers for the four provider processes or Postgres.
- Permission to use the local erasure and commitment packages already inspected on the Mac.

## Needed before Coston2 deployment

- One Coston2 deployer wallet.
- Four Coston2 provider operator wallets, or permission to derive four test-only operator accounts from a locally stored seed.
- Coston2 test funds for the deployer and provider accounts.
- The deployed `PrimeServerRegistry` address, after the deployment transaction is independently confirmed.
- The wallet addresses can be sent in chat for verification. Private keys must stay in `/Users/user/Documents/prime-server/.env` or another local secret file.
- If a private RPC or WebSocket endpoint is preferred, provide its local environment variable or secret-file path. The public Flare endpoints are already known and can be used otherwise.

Suggested local variables:

```dotenv
PRIME_SERVER_DEPLOYER_PRIVATE_KEY=
PRIME_SERVER_PROVIDER_1_PRIVATE_KEY=
PRIME_SERVER_PROVIDER_2_PRIVATE_KEY=
PRIME_SERVER_PROVIDER_3_PRIVATE_KEY=
PRIME_SERVER_PROVIDER_4_PRIVATE_KEY=
PRIME_SERVER_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
PRIME_SERVER_WSS_URL=wss://coston2-api.flare.network/ext/C/ws
PRIME_SERVER_REGISTRY_ADDRESS=
```

## Needed for a public demo

These are optional for the first local and Coston2 proof:

- A public host or VPS for provider endpoints.
- A domain name and TLS certificates if the provider endpoints must be reachable over HTTPS.
- A GitHub repository location and push permission if the local repository should be connected to a remote.

## Not needed yet

- Mainnet funds.
- Production customer data.
- FDC credentials.
- FCC credentials.
- A public payment processor.
- Four physical servers. Four isolated provider processes on the Mac are enough for the first failure proof.

## Input acceptance rule

When an input arrives, verify it locally and record only safe evidence such as an address, chain ID, endpoint health, or tool version. Do not record private keys, seed phrases, or secret values.

## Current Mac toolchain

Verified on 2026-08-03:

```text
Node.js  v22.22.3
npm      10.9.8
pnpm     10.33.2
Foundry  1.7.1
Go       1.26.4
Rust     1.96.0
```

Docker Desktop and its CLI are installed. The Docker daemon is currently stopped. The first contract and provider slices can proceed without it. Start Docker Desktop before containerized provider or Postgres work.
