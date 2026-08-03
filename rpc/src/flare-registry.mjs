import { createHash } from "node:crypto";
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

  function resolveProviderId(providerId) {
    const resolved = onchainProviderIds.get(String(providerId));
    return resolved === undefined ? BigInt(providerId) : resolved;
  }

  async function write(wallet, functionName, args) {
    const hash = await wallet.writeContract({ address, abi: primeServerRegistryAbi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
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

    async createBlob({ blobId, commitment, size, chunkSize, dataShards, totalShards }) {
      return write(deployerWallet, "createBlob", [
        `0x${blobId.replace(/^0x/, "")}`,
        `0x${commitment.replace(/^0x/, "")}`,
        BigInt(size),
        Number(chunkSize),
        Number(dataShards),
        Number(totalShards)
      ]);
    },

    async assignShard(blobId, shardIndex, providerId) {
      return write(deployerWallet, "assignShard", [
        `0x${blobId.replace(/^0x/, "")}`,
        Number(shardIndex),
        resolveProviderId(providerId)
      ]);
    },

    async acknowledgeShard({ blobId, shardIndex, providerId, commitment, size }) {
      const provider = providerWallets.get(providerId);
      if (!provider) throw new Error(`missing wallet for ${providerId}`);
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
    }
  };
}
