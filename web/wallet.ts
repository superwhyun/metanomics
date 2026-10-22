import { getAddress } from "viem";

export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
};
export type WalletChoice = {
  name: string;
  provider: WalletProvider;
};

export async function revokeWalletConnection(
  provider: WalletProvider,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Connection reset timed out")),
          5000,
        );
      }),
    ]);
    return result === null;
  } catch {
    // Ronin may require disconnecting the origin in Settings > Connected dApps.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
type WalletWindow = EventTarget & {
  ronin?: { provider?: unknown };
  ethereum?: unknown;
};
const isProvider = (value: any): value is WalletProvider =>
  value != null && typeof value.request === "function";

export function walletErrorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const inspect = (value: any, depth = 0): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6)
      return;
    seen.add(value);
    if (value.code === "WALLET_IS_LOCKED")
      return "지갑 앱이 서명값을 반환하지 못했습니다. 지갑을 한 번 잠근 뒤 비밀번호로 잠금을 해제하고 다시 시도하세요.";
    for (const nested of [
      value.cause,
      value.data,
      value.originalError,
      value.error,
    ]) {
      const message = inspect(nested, depth + 1);
      if (message) return message;
    }
    if (Number(value.code) === 4001) return "지갑 요청을 취소했습니다.";
    if (Number(value.code) === -32002)
      return "지갑에 처리 중인 요청이 있습니다. 지갑 앱에서 기존 요청을 승인하거나 취소하세요.";
  };
  return (
    inspect(error) ??
    (error instanceof Error
      ? error.message
      : typeof (error as any)?.message === "string"
        ? (error as any).message
        : "지갑 요청을 처리하지 못했습니다.")
  );
}

// Keep discovery active before the user clicks: extensions may announce early
// or only respond when eip6963:requestProvider is dispatched.
export class WalletDiscovery {
  private announced = new Map<WalletProvider, WalletChoice>();
  private announce = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (
      isProvider(detail?.provider) &&
      typeof detail.info?.name === "string" &&
      detail.info.name.trim()
    )
      this.announced.set(detail.provider, {
        name: detail.info.name.slice(0, 80),
        provider: detail.provider,
      });
  };
  constructor(private host: WalletWindow) {
    host.addEventListener("eip6963:announceProvider", this.announce);
    this.request();
  }
  request() {
    this.host.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  wallets(): WalletChoice[] {
    const wallets = new Map(this.announced);
    const add = (provider: unknown, name: string) => {
      if (isProvider(provider) && !wallets.has(provider))
        wallets.set(provider, { name, provider });
    };
    add(this.host.ronin?.provider, "Ronin Wallet");
    const ethereum = this.host.ethereum as any;
    const legacy = Array.isArray(ethereum?.providers)
      ? ethereum.providers
      : [ethereum];
    for (const provider of legacy)
      add(
        provider,
        provider?.isRonin
          ? "Ronin Wallet"
          : provider?.isMetaMask
            ? "MetaMask"
            : "EVM 지갑",
      );
    return [...wallets.values()];
  }
  close() {
    this.host.removeEventListener("eip6963:announceProvider", this.announce);
  }
}

type Network = {
  chainId: number;
  id: string;
  rpcUrl: string;
  finality: string;
};

export type ConnectOptions = {
  // Ask the wallet to show its account picker again (EIP-2255). Without it an
  // already-authorized site silently receives the previously connected account.
  reselect?: boolean;
  // Called when the wallet exposes several accounts to this site.
  chooseAccount?: (accounts: string[]) => Promise<string>;
};
// The user declined or another prompt is open: do not fall through to a second prompt.
const STOP_CODES = new Set([4001, -32002]);

export async function connectInjectedWallet(
  provider: WalletProvider,
  network: Network,
  options: ConnectOptions = {},
) {
  if (options.reselect) {
    try {
      await provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch (error: any) {
      // Wallets without EIP-2255 (possibly Ronin) keep the plain authorization flow.
      if (STOP_CODES.has(Number(error?.code))) throw error;
    }
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0])
    throw new Error("지갑에서 연결할 계정을 선택하세요.");
  const authorized = accounts
    .filter((a): a is string => typeof a === "string")
    .map((a) => getAddress(a));
  let address = authorized[0];
  if (authorized.length > 1 && options.chooseAccount) {
    const picked = await options.chooseAccount(authorized);
    const match = authorized.find(
      (a) => a.toLowerCase() === String(picked).toLowerCase(),
    );
    if (!match) throw new Error("지갑에서 연결할 계정을 선택하세요.");
    address = match;
  }
  const chainId = `0x${network.chainId.toString(16)}`;
  const switchChain = () =>
    provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (Number(currentChainId) !== network.chainId) {
    try {
      await switchChain();
    } catch (error: any) {
      if (Number(error.code) !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: network.id,
            rpcUrls: [network.rpcUrl],
            nativeCurrency:
              network.finality === "local"
                ? { name: "Ether", symbol: "ETH", decimals: 18 }
                : { name: "RON", symbol: "RON", decimals: 18 },
          },
        ],
      });
      // Some wallets add a network without switching to it.
      await switchChain();
    }
  }
  await assertWalletSession(provider, address, network.chainId);
  return address;
}

export async function assertWalletSession(
  provider: WalletProvider,
  address: string,
  chainId: number,
) {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_accounts" });
  } catch (error: any) {
    if (![4200, -32601].includes(Number(error.code))) throw error;
    accounts = [];
  }
  // Some Ronin providers return [] here even after eth_requestAccounts was
  // approved. All callers run within an explicit connect/sign action: request
  // authorization again instead of treating an empty passive result as a lock.
  // The result must still match the address frozen for this signing request.
  if (Array.isArray(accounts) && accounts.length === 0)
    accounts = await provider.request({ method: "eth_requestAccounts" });
  // The frozen address may be any account this site is authorized for, not only
  // the wallet's first; signing requests name the address explicitly.
  if (
    !Array.isArray(accounts) ||
    !accounts.some(
      (a) => typeof a === "string" && a.toLowerCase() === address.toLowerCase(),
    )
  ) {
    throw new Error(
      "지갑 계정이 변경되었거나 잠겼습니다. 지갑을 다시 연결하세요.",
    );
  }
  const current = await provider.request({ method: "eth_chainId" });
  if (Number(current) !== chainId)
    throw new Error("지갑 네트워크가 다릅니다. 지갑을 다시 연결하세요.");
}
