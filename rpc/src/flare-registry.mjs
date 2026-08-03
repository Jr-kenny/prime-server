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

export function createCoston2Wallet({ privateKey, rpcUrl, chainId = 114 } = {}) {
  const chain = createCoston2Chain(rpcUrl, chainId);
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions);
  return { account, chain, wallet };
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

  function paidRegistrationTuple(registration) {
    return {
      blobId: `0x${registration.blobId.replace(/^0x/, "")}`,
      blobName: registration.blobName || "",
      commitment: `0x${registration.commitment.replace(/^0x/, "")}`,
      size: BigInt(registration.size),
      chunkSize: Number(registration.chunkSize),
      dataShards: Number(registration.dataShards),
      totalShards: Number(registration.totalShards),
      expiresAt: BigInt(registration.expiresAt),
      storageMode: Number(registration.storageMode),
      accessPolicy: Number(registration.accessPolicy),
      policyCommitment: `0x${registration.policyCommitment.replace(/^0x/, "")}`,
      keyEnvelopeCommitment: `0x${registration.keyEnvelopeCommitment.replace(/^0x/, "")}`,
      metadataCommitment: `0x${registration.metadataCommitment.replace(/^0x/, "")}`
    };
  }

  function confidentialAccessRequestTuple(request) {
    return {
      blobId: `0x${request.blobId.replace(/^0x/, "")}`,
      requester: request.requester,
      deviceKeyCommitment: `0x${request.deviceKeyCommitment.replace(/^0x/, "")}`,
      nonce: BigInt(request.nonce),
      deadline: BigInt(request.deadline),
      purpose: Number(request.purpose),
      exists: Boolean(request.exists),
      consumed: Boolean(request.consumed)
    };
  }

  async function readBlobPolicy(blobId) {
    const raw = await publicClient.readContract({
      address,
      abi: primeServerRegistryAbi,
      functionName: "getBlobPolicy",
      args: [`0x${blobId.replace(/^0x/, "")}`]
    });
    const modeNames = ["public", "private", "confidential"];
    const accessNames = ["owner_only", "selected_wallets", "compute_only"];
    return {
      storageMode: Number(raw.storageMode ?? raw[0]),
      storageModeName: modeNames[Number(raw.storageMode ?? raw[0])] || "unknown",
      accessPolicy: Number(raw.accessPolicy ?? raw[1]),
      accessPolicyName: accessNames[Number(raw.accessPolicy ?? raw[1])] || "unknown",
      policyCommitment: (raw.policyCommitment ?? raw[2]).replace(/^0x/, ""),
      keyEnvelopeCommitment: (raw.keyEnvelopeCommitment ?? raw[3]).replace(/^0x/, ""),
      metadataCommitment: (raw.metadataCommitment ?? raw[4]).replace(/^0x/, "")
    };
  }

  async function readBlobPayment(blobId) {
    const raw = await publicClient.readContract({
      address,
      abi: primeServerRegistryAbi,
      functionName: "getBlobPayment",
      args: [`0x${blobId.replace(/^0x/, "")}`]
    });
    const assetNames = ["native_flare", "fxrp", "xrp"];
    const statusNames = ["none", "escrowed", "claimable", "partially_settled", "settled", "refunded"];
    const asset = Number(raw.asset ?? raw[0]);
    const status = Number(raw.status ?? raw[1]);
    return {
      asset,
      assetName: assetNames[asset] || "unknown",
      status,
      statusName: statusNames[status] || "unknown",
      payer: raw.payer ?? raw[2],
      totalPaid: BigInt(raw.totalPaid ?? raw[3]),
      providerPool: BigInt(raw.providerPool ?? raw[4]),
      providerRewardPerShard: BigInt(raw.providerRewardPerShard ?? raw[5]),
      protocolFee: BigInt(raw.protocolFee ?? raw[6]),
      providerSettled: BigInt(raw.providerSettled ?? raw[7]),
      quoteCommitment: (raw.quoteCommitment ?? raw[8]).replace(/^0x/, ""),
      paidAt: Number(raw.paidAt ?? raw[9]),
      settledAt: Number(raw.settledAt ?? raw[10])
    };
  }

  async function write(wallet, functionName, args, value) {
    const request = { address, abi: primeServerRegistryAbi, functionName, args };
    if (value !== undefined) request.value = BigInt(value);
    const hash = await wallet.writeContract(request);
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

    async quoteNativePayment({ size, totalShards, storageMode, expiresAt }) {
      const raw = await publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "quoteNativePayment",
        args: [BigInt(size), Number(totalShards), Number(storageMode), BigInt(expiresAt)]
      });
      return {
        total: BigInt(raw.total ?? raw[0]),
        providerPool: BigInt(raw.providerPool ?? raw[1]),
        protocolFee: BigInt(raw.protocolFee ?? raw[2]),
        providerRewardPerShard: BigInt(raw.providerRewardPerShard ?? raw[3]),
        quoteCommitment: (raw.quoteCommitment ?? raw[4]).replace(/^0x/, "")
      };
    },

    async getConfidentialAccessNonce({ blobId, requester }) {
      return publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "confidentialAccessNonces",
        args: [`0x${blobId.replace(/^0x/, "")}`, requester]
      });
    },

    async hashConfidentialAccess(request) {
      return publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "hashConfidentialAccess",
        args: [confidentialAccessRequestTuple(request)]
      });
    },

    async authorizeConfidentialAccess({ wallet = deployerWallet, request, signature }) {
      return write(wallet, "authorizeConfidentialAccess", [confidentialAccessRequestTuple(request), signature]);
    },

    async getConfidentialAccessRequest(requestId) {
      const raw = await publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "confidentialAccessRequests",
        args: [`0x${requestId.replace(/^0x/, "")}`]
      });
      return {
        blobId: raw.blobId ?? raw[0],
        requester: raw.requester ?? raw[1],
        deviceKeyCommitment: raw.deviceKeyCommitment ?? raw[2],
        nonce: BigInt(raw.nonce ?? raw[3]),
        deadline: Number(raw.deadline ?? raw[4]),
        purpose: Number(raw.purpose ?? raw[5]),
        exists: Boolean(raw.exists ?? raw[6]),
        consumed: Boolean(raw.consumed ?? raw[7])
      };
    },

    async isConfidentialAccessUsable(requestId) {
      return publicClient.readContract({
        address,
        abi: primeServerRegistryAbi,
        functionName: "isConfidentialAccessUsable",
        args: [`0x${requestId.replace(/^0x/, "")}`]
      });
    },

    async recordConfidentialAccessResult({ requestId, responseCommitment, wallet = deployerWallet }) {
      return write(wallet, "recordConfidentialAccessResult", [
        `0x${requestId.replace(/^0x/, "")}`,
        `0x${responseCommitment.replace(/^0x/, "")}`
      ]);
    },

    async setConfidentialAccessController({ controller, allowed, wallet = deployerWallet }) {
      return write(wallet, "setConfidentialAccessController", [controller, Boolean(allowed)]);
    },

    async setBlobWalletAccess({ blobId, wallet: selectedWallet, allowed, controllerWallet = deployerWallet }) {
      return write(controllerWallet, "setBlobWalletAccess", [
        `0x${blobId.replace(/^0x/, "")}`,
        selectedWallet,
        Boolean(allowed)
      ]);
    },

    async createBlobPaid({ wallet = deployerWallet, registration, value }) {
      return write(wallet, "createBlobPaid", [paidRegistrationTuple(registration)], value);
    },

    async createBlobNamedPaid({ wallet = deployerWallet, registration, value }) {
      return write(wallet, "createBlobNamedPaid", [paidRegistrationTuple(registration)], value);
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

    async claimProviderSettlement({ blobId, providerId, shardIndices }) {
      const provider = providerWallets.get(String(providerId));
      if (!provider) throw new Error(`missing wallet for ${providerId}`);
      return write(provider.wallet, "claimProviderSettlement", [
        `0x${blobId.replace(/^0x/, "")}`,
        shardIndices.map((shardIndex) => Number(shardIndex))
      ]);
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

    async getBlobPolicy(blobId) {
      return readBlobPolicy(blobId);
    },

    async getBlobPayment(blobId) {
      return readBlobPayment(blobId);
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
        acknowledgements,
        policy: await readBlobPolicy(blobId),
        payment: await readBlobPayment(blobId)
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
