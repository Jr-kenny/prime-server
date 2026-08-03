# AWS node deployment

This deployment runs the first public Prime Server node on one EC2 instance. The host runs four isolated provider child processes and one Prime RPC process. Provider data and the operational recovery state live on an encrypted gp3 EBS volume.

The deployment uses:

- Amazon Linux 2023 on `m7g.medium` Arm64.
- One private ECR image named `prime-server`.
- Systems Manager Session Manager instead of SSH.
- IMDSv2 required, with a two-hop limit for container access.
- SSM Parameter Store SecureString values for the Coston2 environment and provider identities.
- A security group with only TCP `8080` open to the public RPC.
- A CloudWatch log group at `/prime-server/node` with fourteen-day retention.

The normal market type is on-demand. If the account's on-demand vCPU quota is temporarily constrained, run with `PRIME_SERVER_MARKET_TYPE=spot bash deploy/aws/deploy.sh`. Spot mode uses stop-on-interruption so the encrypted volume and operational state remain attached, but the public IP can change after a stop and the node is subject to Spot capacity reclamation.

The deployment intentionally keeps payment extension work out of the node. The current node uses the already deployed Coston2 registry and preserves the four provider identities from the canonical live proof.

Run from the repository root after the local `.env` and the canonical `.prime-server/coston2/<run>/providers` identities exist:

```bash
bash deploy/aws/deploy.sh
```

For the current account while its on-demand quota request is open:

```bash
PRIME_SERVER_MARKET_TYPE=spot bash deploy/aws/deploy.sh
```

The script builds for `linux/arm64`, pushes an immutable Git-tagged image to ECR, provisions the runtime role and instance profile, stores the ignored environment values in SSM, launches the host, and waits for `/health`.

The deployment is a public show node, not a claim of four physically independent operators. The next infrastructure step is moving each provider to a separate host or region while keeping the same contract and RPC boundary.
