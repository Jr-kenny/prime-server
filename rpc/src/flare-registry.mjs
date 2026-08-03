import { createHash, createPublicKey, verify } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  publicActions,
  walletActions
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { primeServerRegistryAbi } from "./registry-abi.mjs";
import { acknowledgementContext } from "./ack-context.mjs";

function normalizePrivateKey(value) {
  if (!value) throw new Error("private key is required");
  return value.startsWith("0x") ? value : `0x${value}`;
}

export function createCoston2Chain(rpcUrl, chainId = 114) {
  return defineChain({
    id: chainId,
    name: chainId === 114 ? "Flare Coston2" : "Prime Server local EVM",
    nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
}

export function createFlareRegistry({
  address,
  rpcUrl = "https://coston2-api.flare.network/ext/C/rpc",
  deployerPrivateKey,
  providerPrivateKeys = {},
  chainId = 114
} = {}) {
  if (!address) throw new Error("PrimeServerRegistry address is required");
  const chain = createCoston2Chain(rpcUrl, chainId);
  const deployerAccount = privateKeyToAccount(normalizePrivateKey(deployerPrivateKey));
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({ account: deployerAccount, chain, transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions);
  const providerWallets = new Map(
    Object.entries(providerPrivateKeys).map(([providerId, privateKey]) => {
      const account = privateKeyToAccount(normalizePrivateKey(privateKey));
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
        .extend(publicActions)
        .extend(walletActions);
      return [providerId, { account, wallet }];
    })
  );
  const onchainProviderIds = new Map();
  const localProviderIdsByChainId = new Map();
  const transactionJournal = [];
  const providerSigningKeys = new Map();

  function resolveProviderId(providerId) {
    const resolved = onchainProviderIds.get(String(providerId));
    return resolved === undefined ? BigInt(providerId) : resolved;
  }

  async function write(wallet, functionName, args) {
    const hash = await wallet.writeContract({ address, abi: primeServerRegistryAbi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    transactionJournal.push({
      functionName,
      hash,
      blockNumber: receipt.blockNumber?.toString(),
      status: receipt.status
    });
    return { hash, receipt };
  }

  return {
    chain,
    address,
    publicClient,
    deployer: deployerAccount.address,

    async registerProvider({ providerId, endpoint, signingKey, publicKey }) {
      const provider = providerWallets.get(providerId);
      if (!provider) throw new Error(`missing wallet for ${providerId}`);
      if (publicKey) providerSigningKeys.set(String(providerId), publicKey);
      const existingProviderId = await publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "providerIdByOperator",
        args: [provider.account.address]
      });
      if (existingProviderId !== 0n) {
        onchainProviderIds.set(String(providerId), existingProviderId);
        localProviderIdsByChainId.set(existingProviderId.toString(), String(providerId));
        return {
          hash: null,
          receipt: null,
          providerId: existingProviderId.toString(),
          operator: provider.account.address,
          alreadyRegistered: true
        };
      }
      const resolvedSigningKey = signingKey || createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
      const result = await write(provider.wallet, "registerProvider", [endpoint, `0x${resolvedSigningKey.replace(/^0x/, "")}`]);
      const onchainProviderId = await publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "providerIdByOperator",
        args: [provider.account.address]
      });
      onchainProviderIds.set(String(providerId), onchainProviderId);
      localProviderIdsByChainId.set(onchainProviderId.toString(), String(providerId));
      return { ...result, providerId: onchainProviderId.toString(), operator: provider.account.address };
    },

    async createBlob({ blobId, commitment, size, chunkSize, dataShards, totalShards, expiresAt = 0 }) {
      const args = [
        `0x${blobId.replace(/^0x/, "")}`,
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size),
        Number(chunkSize),
        Number(dataShards),
        Number(totalShards)
      ];
      return write(deployerWallet, "createOperatorBlob", [...args, BigInt(expiresAt)]);
    },

    async createBlobNamed({ wallet = deployerWallet, blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt }) {
      return write(wallet, "createBlobNamed", [
        `0x${blobId.replace(/^0x/, "")}`,
        blobName,
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size),
        Number(chunkSize),
        Number(dataShards),
        Number(totalShards),
        BigInt(expiresAt)
      ]);
    },

    async createOperatorBlob({ blobId, commitment, size, chunkSize, dataShards, totalShards, expiresAt }) {
      return write(deployerWallet, "createOperatorBlob", [
        `0x${blobId.replace(/^0x/, "")}`,
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size),
        Number(chunkSize),
        Number(dataShards),
        Number(totalShards),
        BigInt(expiresAt)
      ]);
    },

    async createOperatorBlobNamed({ blobId, blobName, commitment, size, chunkSize, dataShards, totalShards, expiresAt }) {
      return write(deployerWallet, "createOperatorBlobNamed", [
        `0x${blobId.replace(/^0x/, "")}`,
        blobName,
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size),
        Number(chunkSize),
        Number(dataShards),
        Number(totalShards),
        BigInt(expiresAt)
      ]);
    },

    async assignShard(blobId, shardIndex, providerId) {
      return write(deployerWallet, "assignShard", [
        `0x${blobId.replace(/^0x/, "")}`,
        Number(shardIndex),
        resolveProviderId(providerId)
      ]);
    },

    async acknowledgeShard({ blobId, shardIndex, providerId, commitment, size, ackContext, signedPayload, signature }) {
      const provider = providerWallets.get(providerId);
      if (!provider) throw new Error(`missing wallet for ${providerId}`);
      const providerPublicKey = providerSigningKeys.get(String(providerId));
      if (providerPublicKey && ackContext && signedPayload && signature) {
        const blob = await this.getBlob(blobId);
        const expectedPayload = acknowledgementContext({
          chainId: chain.id,
          registryAddress: address,
          blobId,
          owner: blob.owner,
          nameHash: blob.nameHash,
          providerId,
          shardIndex,
          commitment,
          size
        });
        if (ackContext !== expectedPayload || signedPayload !== expectedPayload) {
          throw new Error("provider acknowledgement context mismatch");
        }
        const valid = verify(
          null,
          Buffer.from(signedPayload),
          createPublicKey({ key: Buffer.from(providerPublicKey, "base64"), type: "spki", format: "der" }),
          Buffer.from(signature, "base64")
        );
        if (!valid) throw new Error("invalid provider acknowledgement signature");
      }
      return write(provider.wallet, "acknowledgeShard", [
        `0x${blobId.replace(/^0x/, "")}`,
        Number(shardIndex),
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size)
      ]);
    },

    async finalizeBlob(blobId) {
      return write(deployerWallet, "finalizeBlob", [`0x${blobId.replace(/^0x/, "")}`]);
    },

    async startRecovery(blobId, shardIndex) {
      return write(deployerWallet, "startRecovery", [`0x${blobId.replace(/^0x/, "")}`, Number(shardIndex)]);
    },

    async reassignShard(blobId, shardIndex, providerId) {
      return write(deployerWallet, "reassignShard", [
        `0x${blobId.replace(/^0x/, "")}`,
        Number(shardIndex),
        resolveProviderId(providerId)
      ]);
    },

    async recordRebuiltShard({ blobId, shardIndex, providerId, commitment }) {
      return write(deployerWallet, "recordRebuiltShard", [
        `0x${blobId.replace(/^0x/, "")}`,
        Number(shardIndex),
        resolveProviderId(providerId),
        `0x${commitment.replace(/^0x/, "")}`
      ]);
    },

    async getBlob(blobId) {
      const raw = await publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "blobs",
        args: [`0x${blobId.replace(/^0x/, "")}`]
      });
      if (!raw[8]) return null;
      const totalShards = Number(raw[5]);
      const placement = {};
      const acknowledgements = [];
      for (let shardIndex = 0; shardIndex < totalShards; shardIndex += 1) {
        const providerChainId = await publicClient.readContract({
          address,
          abi: primeServerRegistryAbi,
          functionName: "placement",
          args: [`0x${blobId.replace(/^0x/, "")}`, shardIndex]
        });
        const providerId = localProviderIdsByChainId.get(providerChainId.toString()) || providerChainId.toString();
        placement[shardIndex] = providerId;
        if (providerChainId === 0n) continue;
        const acknowledgement = await publicClient.readContract({
          address,
          abi: primeServerRegistryAbi,
          functionName: "acknowledgements",
          args: [`0x${blobId.replace(/^0x/, "")}`, providerChainId, shardIndex]
        });
        if (acknowledgement[3]) {
          acknowledgements.push({
            providerId,
            shardIndex,
            commitment: acknowledgement[0].replace(/^0x/, ""),
            size: Number(acknowledgement[1])
          });
        }
      }
      const statusNames = ["pending", "active", "recovering", "rebuilt", "revoked"];
      let nameHash = "";
      let blobName = "";
      try {
        nameHash = (await publicClient.readContract({
          address,
          abi: primeServerRegistryAbi,
          functionName: "blobNameHashes",
          args: [`0x${blobId.replace(/^0x/, "")}`]
        })).replace(/^0x/, "");
        if (nameHash && !/^0+$/.test(nameHash)) {
          blobName = await publicClient.readContract({
            address,
            abi: primeServerRegistryAbi,
            functionName: "blobNames",
            args: [`0x${blobId.replace(/^0x/, "")}`]
          });
        }
      } catch {
        // The compatibility path supports registries deployed before named blobs.
      }
      return {
        blobId,
        owner: raw[0],
        commitment: raw[1].replace(/^0x/, ""),
        size: Number(raw[2]),
        chunkSize: Number(raw[3]),
        dataShards: Number(raw[4]),
        totalShards,
        acknowledgementCount: Number(raw[6]),
        status: statusNames[Number(raw[7])] || "unknown",
        expiresAt: Number(raw[9] || 0),
        origin: raw.length > 10 ? (Number(raw[10]) === 1 ? "operator" : "user") : "unknown",
        nameHash,
        blobName,
        placement,
        acknowledgements
      };
    },

    async getPlacement(blobId, shardIndex) {
      return publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "placement",
        args: [`0x${blobId.replace(/^0x/, "")}`, Number(shardIndex)]
      });
    },

    providerOperators() {
      return Object.fromEntries([...providerWallets.entries()].map(([providerId, provider]) => [providerId, provider.account.address]));
    },

    transactionJournal() {
      return transactionJournal.map((entry) => ({ ...entry }));
    }
  };
}
