import type { EIP1193Provider } from "viem";
import { coston2 } from "./registry";

export type InjectedProvider = EIP1193Provider & {
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isMetaMask?: boolean;
  isRabby?: boolean;
  providers?: InjectedProvider[];
  on?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
};

export type WalletOption = { id: string; name: string; provider: InjectedProvider };
type Eip6963Detail = { info: { name: string; rdns: string; uuid: string }; provider: InjectedProvider };

const coston2ChainId = `0x${coston2.id.toString(16)}`;
const coston2WalletParams = {
  chainId: coston2ChainId,
  chainName: coston2.name,
  nativeCurrency: coston2.nativeCurrency,
  rpcUrls: [...coston2.rpcUrls.default.http],
  blockExplorerUrls: [coston2.blockExplorers.default.url]
};

function nestedErrorValues(error: unknown): unknown[] {
  if (typeof error !== "object" || error === null) return [];
  const record = error as Record<string, unknown>;
  return [record.cause, record.error, record.data, typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>).originalError : undefined].filter(Boolean);
}

export function walletErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Number((error as { code?: unknown }).code);
    if (Number.isFinite(code)) return code;
  }
  for (const nested of nestedErrorValues(error)) {
    const code = walletErrorCode(nested);
    if (code !== undefined) return code;
  }
  return undefined;
}

export function walletErrorMessage(error: unknown): string {
  const code = walletErrorCode(error);
  if (code === 4001) return "The wallet request was declined.";
  if (code === -32002) return "A wallet request is already open. Finish it in your wallet, then try again.";
  if (code === 4100) return "This site is not authorized in your wallet. Open the wallet and approve the connection.";
  if (code === 4902) return "Flare Testnet Coston2 has not been added to this wallet yet.";
  const directMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (directMessage.toLowerCase().includes("too many requests") || /status:\s*429/i.test(directMessage)) return "Coston2 RPC is rate-limiting requests. Wait a moment and try again. If the upload completed, refresh to confirm its onchain status.";
  if (error instanceof Error && error.message && error.message !== "[object Object]") return error.message;
  if (typeof error === "string" && error && error !== "[object Object]") return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "reason", "message"]) {
      if (typeof record[key] === "string" && record[key] && record[key] !== "[object Object]") return record[key] as string;
    }
  }
  for (const nested of nestedErrorValues(error)) {
    const message = walletErrorMessage(nested);
    if (message !== "Wallet connection failed. Open your wallet and try again.") return message;
  }
  return "Wallet connection failed. Open your wallet and try again.";
}

function normalizeChainId(value: unknown) {
  const chainId = String(value).toLowerCase();
  return chainId.startsWith("0x") ? chainId : `0x${Number(chainId).toString(16)}`;
}

function isUnknownWalletChain(error: unknown) {
  const code = walletErrorCode(error);
  const message = walletErrorMessage(error).toLowerCase();
  return code === 4902 || message.includes("unrecognized chain") || message.includes("unknown chain") || message.includes("chain not added") || message.includes("has not been added");
}

export async function ensureCoston2Network(provider: InjectedProvider): Promise<"ready" | "switched" | "added"> {
  const currentChainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
  if (currentChainId === coston2ChainId) return "ready";
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: coston2ChainId }] });
  } catch (error) {
    if (walletErrorCode(error) === 4001) throw new Error("Approve the switch to Flare Testnet Coston2 in your wallet to continue.");
    if (!isUnknownWalletChain(error)) throw error;
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: [coston2WalletParams] });
    } catch (addError) {
      if (walletErrorCode(addError) === 4001) throw new Error("Approve adding Flare Testnet Coston2 in your wallet to continue.");
      throw addError;
    }
    const chainAfterAdd = normalizeChainId(await provider.request({ method: "eth_chainId" }));
    if (chainAfterAdd !== coston2ChainId) await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: coston2ChainId }] });
    const addedChainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
    if (addedChainId !== coston2ChainId) throw new Error("Your wallet must be connected to Flare Testnet Coston2 to continue.");
    return "added";
  }
  const selectedChainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
  if (selectedChainId !== coston2ChainId) throw new Error("Your wallet must be connected to Flare Testnet Coston2 to continue.");
  return "switched";
}

function legacyWalletName(provider: InjectedProvider, index: number) {
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return index ? `Browser wallet ${index + 1}` : "Browser wallet";
}

export function watchInjectedWallets(onChange: (wallets: WalletOption[]) => void) {
  const wallets: WalletOption[] = [];
  const add = (option: WalletOption) => {
    if (wallets.some((wallet) => wallet.provider === option.provider)) return;
    wallets.push(option);
    onChange([...wallets]);
  };
  const ethereum = window.ethereum as InjectedProvider | undefined;
  const legacyProviders = ethereum?.providers?.length ? ethereum.providers : ethereum ? [ethereum] : [];
  legacyProviders.forEach((provider, index) => add({ id: `legacy-${index}`, name: legacyWalletName(provider, index), provider }));
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (detail?.provider && detail.info) add({ id: `${detail.info.rdns}:${detail.info.uuid}`, name: detail.info.name, provider: detail.provider });
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", announce);
}
