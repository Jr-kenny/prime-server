import { hexToBytes, type Address } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytes32, jsonBytes, type PreparedConfidentialBlob } from "./confidential";

export const fccSenderAbi = [{
  type: "function",
  name: "requestConfidentialCompute",
  stateMutability: "payable",
  inputs: [
    { name: "requestId", type: "bytes32" },
    { name: "keyEnvelope", type: "bytes" },
    { name: "computeSpec", type: "bytes" },
    { name: "inputCommitment", type: "bytes32" }
  ],
  outputs: [{ name: "instructionId", type: "bytes32" }]
}] as const;

export const fccVerifierAbi = [{
  type: "function",
  name: "submitResult",
  stateMutability: "nonpayable",
  inputs: [
    { name: "requestId", type: "bytes32" },
    { name: "resultData", type: "bytes" },
    { name: "actionId", type: "bytes32" },
    { name: "submissionTag", type: "string" },
    { name: "status", type: "uint8" },
    { name: "signature", type: "bytes" }
  ],
  outputs: []
}] as const;

const accessTypes = {
  ConfidentialAccess: [
    { name: "blobId", type: "bytes32" },
    { name: "requester", type: "address" },
    { name: "deviceKeyCommitment", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "purpose", type: "uint8" }
  ]
} as const;

export type FccActionResult = {
  id: `0x${string}`;
  data: `0x${string}`;
  submissionTag: string;
  status: number;
};

export function fccPublicKeyFromInfo(info: any): string {
  const key = info?.machineData?.publicKey || info?.machine_data?.public_key;
  const x = String(key?.x || "").replace(/^0x/, "");
  const y = String(key?.y || "").replace(/^0x/, "");
  if (!/^[a-fA-F0-9]{64}$/.test(x) || !/^[a-fA-F0-9]{64}$/.test(y)) throw new Error("FCC proxy did not return a usable public key");
  return `0x04${x}${y}`;
}

export function decodeFccResult(data: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(hexToBytes(data as `0x${string}`))) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`FCC result data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function instructionIdFromReceipt(receipt: any, requestId: string, senderAddress: Address): `0x${string}` {
  for (const log of receipt?.logs || []) {
    if (String(log.address || "").toLowerCase() !== senderAddress.toLowerCase()) continue;
    const topics = log.topics || [];
    if (topics.length >= 4 && String(topics[1]).toLowerCase() === requestId.toLowerCase()) return topics[3] as `0x${string}`;
  }
  throw new Error("FCC instruction event was not found in the sender receipt");
}

export async function authorizeAndRequestCompute({
  publicClient,
  walletClient,
  account,
  registryAddress,
  senderAddress,
  prepared,
  operation,
  field,
  instructionFeeWei = "1000000"
}: {
  publicClient: any;
  walletClient: any;
  account: Address;
  registryAddress: Address;
  senderAddress: Address;
  prepared: PreparedConfidentialBlob;
  operation: string;
  field?: string;
  instructionFeeWei?: string;
}) {
  const deviceKey = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false);
  const deviceKeyCommitment = bytes32(deviceKey);
  const nonce = BigInt(await publicClient.readContract({
    address: registryAddress,
    abi: [{ type: "function", name: "confidentialAccessNonces", stateMutability: "view", inputs: [{ name: "blobId", type: "bytes32" }, { name: "requester", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
    functionName: "confidentialAccessNonces",
    args: [prepared.blobId, account]
  }));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const request = {
    blobId: prepared.blobId,
    requester: account,
    deviceKeyCommitment,
    nonce,
    deadline,
    purpose: 1,
    exists: false,
    consumed: false
  };
  const chainId = await publicClient.getChainId();
  const domain = {
    name: "Prime Server Registry",
    version: "1",
    chainId,
    verifyingContract: registryAddress
  };
  const signature = await walletClient.signTypedData({ account, domain, types: accessTypes, primaryType: "ConfidentialAccess", message: request });
  const requestId = await publicClient.readContract({
    address: registryAddress,
    abi: [{
      type: "function",
      name: "hashConfidentialAccess",
      stateMutability: "view",
      inputs: [{ name: "request", type: "tuple", components: [
        { name: "blobId", type: "bytes32" }, { name: "requester", type: "address" },
        { name: "deviceKeyCommitment", type: "bytes32" }, { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" }, { name: "purpose", type: "uint8" },
        { name: "exists", type: "bool" }, { name: "consumed", type: "bool" }
      ] }] as const,
      outputs: [{ type: "bytes32" }]
    }] as const,
    functionName: "hashConfidentialAccess",
    args: [request]
  }) as `0x${string}`;
  const authorizeHash = await walletClient.writeContract({
    address: registryAddress,
    abi: [{
      type: "function",
      name: "authorizeConfidentialAccess",
      stateMutability: "nonpayable",
      inputs: [
        { name: "request", type: "tuple", components: [
          { name: "blobId", type: "bytes32" }, { name: "requester", type: "address" },
          { name: "deviceKeyCommitment", type: "bytes32" }, { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" }, { name: "purpose", type: "uint8" },
          { name: "exists", type: "bool" }, { name: "consumed", type: "bool" }
        ] },
        { name: "signature", type: "bytes" }
      ],
      outputs: [{ name: "requestId", type: "bytes32" }]
    }] as const,
    functionName: "authorizeConfidentialAccess",
    account,
    args: [request, signature]
  });
  const authorizeReceipt = await publicClient.waitForTransactionReceipt({ hash: authorizeHash });
  if (authorizeReceipt.status !== "success") throw new Error("FCC access authorization reverted on Coston2");

  const computeSpec = field ? { operation: operation.toLowerCase(), field } : { operation: operation.toLowerCase() };
  const requestHash = await walletClient.writeContract({
    address: senderAddress,
    abi: fccSenderAbi,
    functionName: "requestConfidentialCompute",
    account,
    args: [requestId, jsonBytes(prepared.keyEnvelope), jsonBytes(computeSpec), bytes32(prepared.ciphertext)],
    value: BigInt(instructionFeeWei)
  });
  const requestReceipt = await publicClient.waitForTransactionReceipt({ hash: requestHash });
  if (requestReceipt.status !== "success") throw new Error("FCC compute request reverted on Coston2");
  return {
    requestId,
    authorizeHash,
    requestHash,
    instructionId: instructionIdFromReceipt(requestReceipt, requestId, senderAddress),
    computeSpec
  };
}
