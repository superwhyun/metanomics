import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  keccak256,
  verifyTypedData,
  verifyMessage,
  parseSignature,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact } from "./contracts.js";
import {
  AppError,
  chainIdOf,
  emptyPermit,
  permitTypes,
  paymentTypes,
  budgetTypes,
  resolutionTypes,
  type Deployment,
  type SigningRequest,
} from "./shared.js";

const TOKEN_FUNCTIONS = new Set(["mint", "approve"]);
// The relayer is an externally owned account, so a transfer costs the base fee.
export const NATIVE_TRANSFER_GAS = 21_000n;
export const MAX_CONFIRMATIONS = 1000;
export const validConfirmations = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= MAX_CONFIRMATIONS;

export interface ChainAdapter {
  deployment: Deployment;
  capabilities(): {
    evm: boolean;
    typedData: boolean;
    permit: boolean;
    finality: string;
    maxLogBlockRange: number;
  };
  finalBlock(confirmations?: number | null): Promise<any>;
  latestBlock(): Promise<any>;
  getBalance(address: Address, blockNumber?: bigint): Promise<bigint>;
  getGameBudget(gameId: string, blockNumber?: bigint): Promise<bigint>;
  prepareWalletProof(input: {
    origin: string;
    playerId: string;
    address: Address;
    nonce: string;
    expiresAt: number;
  }): string;
  verifyWalletProof(
    message: string,
    signature: Hex,
    address: Address,
  ): Promise<boolean>;
  prepareAuthorization(
    kind: "Payment" | "BudgetAction" | "Resolution",
    message: any,
  ): SigningRequest;
  verifyAuthorization(
    request: SigningRequest,
    signature: Hex,
    address: Address,
  ): Promise<boolean>;
  buildTransaction(
    functionName: string,
    args: any[],
    signer: string,
    nonce: number,
    gasPrice?: bigint,
    fixedGas?: bigint,
  ): Promise<{ raw: Hex; hash: Hex; nonce: number }>;
  broadcastTransaction(raw: Hex): Promise<Hex>;
  getTransactionStatus(hash: Hex): Promise<any>;
  readEvents(fromBlock: bigint, toBlock: bigint): Promise<any[]>;
  reconcileOperation(
    kind: string,
    resourceId: string,
    blockNumber: bigint,
  ): Promise<boolean>;
}

export class EvmAdapter implements ChainAdapter {
  publicClient: any;
  wallets: Record<string, any>;
  constructor(
    public deployment: Deployment,
    keys: { relayer: Hex; admin?: Hex },
  ) {
    const chain = defineChain({
      id: deployment.chainId,
      name: deployment.id,
      nativeCurrency: { name: "RON", symbol: "RON", decimals: 18 },
      rpcUrls: { default: { http: [deployment.rpcUrl] } },
    });
    this.publicClient = createPublicClient({
      chain,
      transport: http(deployment.rpcUrl, { timeout: 10_000, retryCount: 0 }),
    });
    this.wallets = Object.fromEntries(
      Object.entries(keys)
        .filter(([, key]) => key)
        .map(([kind, key]) => [
          kind,
          createWalletClient({
            account: privateKeyToAccount(key!),
            chain,
            transport: http(deployment.rpcUrl),
          }),
        ]),
    );
    if (
      this.wallets.relayer.account.address.toLowerCase() !==
      deployment.relayer.toLowerCase()
    )
      throw new Error("Relayer key does not match deployment");
    if (
      this.wallets.admin &&
      this.wallets.admin.account.address.toLowerCase() !==
        deployment.admin.toLowerCase()
    )
      throw new Error("Admin key does not match deployment");
    if (deployment.finality === "local" && deployment.chainId !== 31337)
      throw new Error("Local finality is restricted to chain 31337");
    if (
      deployment.finality === "depth" &&
      !validConfirmations(deployment.confirmations)
    )
      throw new Error(
        `Depth finality needs an integer confirmations value from 1 to ${MAX_CONFIRMATIONS}`,
      );
  }
  capabilities() {
    return {
      evm: true,
      typedData: true,
      permit: true,
      finality: this.deployment.finality,
      maxLogBlockRange: this.deployment.maxLogBlockRange ?? 200,
    };
  }
  async validate() {
    await this.finalBlock();
    const [token, relayerRole, adminRole, decimals, claimWindow] =
      await Promise.all([
        this.read("token"),
        this.read("hasRole", [
          chainIdOf("RELAYER_ROLE"),
          this.deployment.relayer,
        ]),
        this.read("hasRole", [`0x${"00".repeat(32)}`, this.deployment.admin]),
        this.publicClient.readContract({
          address: this.deployment.token,
          abi: artifact("CommonCredit").abi,
          functionName: "decimals",
        }),
        this.deployment.claimWindowSeconds === undefined &&
        this.deployment.chainId === 31337
          ? Promise.resolve(900n)
          : this.read("claimWindow"),
      ]);
    if (
      token.toLowerCase() !== this.deployment.token.toLowerCase() ||
      !relayerRole ||
      !adminRole ||
      decimals !== 6 ||
      Number(claimWindow) !== (this.deployment.claimWindowSeconds ?? 900)
    )
      throw new Error(
        "Deployment contracts, decimals, claim window, or signer roles do not match immutable configuration",
      );
  }
  async chainTime() {
    return Number(
      (await this.publicClient.getBlock({ blockTag: "latest" })).timestamp,
    );
  }
  prepareWalletProof(input: {
    origin: string;
    playerId: string;
    address: Address;
    nonce: string;
    expiresAt: number;
  }) {
    return `${input.origin}\nMetanomic wallet ownership\nPlayer: ${input.playerId}\nAddress: ${input.address}\nChain: ${this.deployment.chainId}\nPurpose: link-wallet\nNonce: ${input.nonce}\nExpires: ${new Date(input.expiresAt).toISOString()}`;
  }
  async verifyWalletProof(message: string, signature: Hex, address: Address) {
    return verifyMessage({ message, signature, address }).catch(() => false);
  }
  prepareAuthorization(
    kind: "Payment" | "BudgetAction" | "Resolution",
    message: any,
  ): SigningRequest {
    return {
      domain: this.domain(),
      types:
        kind === "Payment"
          ? paymentTypes
          : kind === "BudgetAction"
            ? budgetTypes
            : resolutionTypes,
      primaryType: kind,
      message,
    };
  }
  async latestBlock() {
    try {
      if ((await this.publicClient.getChainId()) !== this.deployment.chainId)
        throw new Error("RPC chain ID mismatch");
      const block = await this.publicClient.getBlock({ blockTag: "latest" });
      if (!block.hash || block.number === null)
        throw new Error("Latest block unavailable");
      return block;
    } catch {
      throw new AppError(
        503,
        "LATEST_BALANCE_UNAVAILABLE",
        "최신 잔액을 확인할 수 없습니다.",
      );
    }
  }
  /**
   * The newest block treated as settled. `confirmations` (1..MAX) overrides the
   * deployment setting for one caller, e.g. a game that chose a faster policy.
   * One confirmation is the block that includes the transaction, so 1 settles
   * as soon as a transaction is in the latest block. This is soft finality on
   * the sequencer's chain, not L1 finality.
   */
  async finalBlock(confirmationsOverride?: number | null) {
    try {
      if ((await this.publicClient.getChainId()) !== this.deployment.chainId)
        throw new Error("RPC chain ID mismatch");
      const { finality } = this.deployment;
      const confirmations =
        confirmationsOverride ??
        (finality === "depth" ? this.deployment.confirmations : undefined);
      let block;
      if (confirmations !== undefined) {
        if (!validConfirmations(confirmations))
          throw new Error("Invalid confirmations");
        const head = await this.publicClient.getBlock({ blockTag: "latest" });
        if (head.number === null) throw new Error("Latest block unavailable");
        const below = BigInt(confirmations - 1);
        block =
          below === 0n
            ? head
            : await this.publicClient.getBlock({
                blockNumber: head.number > below ? head.number - below : 0n,
              });
      } else
        block = await this.publicClient.getBlock({
          blockTag: finality === "local" ? "latest" : "finalized",
        });
      if (!block.hash || block.number === null)
        throw new Error("Finalized block unavailable");
      return block;
    } catch {
      throw new AppError(
        503,
        "FINALITY_UNAVAILABLE",
        "체인의 확정 상태를 확인할 수 없습니다.",
      );
    }
  }
  async read(
    functionName: string,
    args: any[] = [],
    blockNumber?: bigint,
  ): Promise<any> {
    return this.publicClient.readContract({
      address: this.deployment.settlement,
      abi: artifact("Settlement").abi,
      functionName,
      args,
      blockNumber,
    });
  }
  async getBalance(address: Address, blockNumber?: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.token,
      abi: artifact("CommonCredit").abi,
      functionName: "balanceOf",
      args: [address],
      blockNumber,
    });
  }
  async readToken(
    functionName: "totalSupply" | "cap",
    blockNumber?: bigint,
  ): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.token,
      abi: artifact("CommonCredit").abi,
      functionName,
      blockNumber,
    }) as Promise<bigint>;
  }
  async getGameBudget(gameId: string, blockNumber?: bigint): Promise<bigint> {
    return this.read("budgets", [chainIdOf(gameId)], blockNumber);
  }
  domain() {
    return {
      name: "Metanomic Settlement",
      version: "1",
      chainId: this.deployment.chainId,
      verifyingContract: this.deployment.settlement,
    };
  }
  async preparePermit(
    owner: Address,
    value: bigint,
    deadline: number,
  ): Promise<SigningRequest> {
    const nonce = await this.publicClient.readContract({
      address: this.deployment.token,
      abi: artifact("CommonCredit").abi,
      functionName: "nonces",
      args: [owner],
    });
    return {
      domain: {
        name: "Common Game Credit",
        version: "1",
        chainId: this.deployment.chainId,
        verifyingContract: this.deployment.token,
      },
      types: permitTypes,
      primaryType: "Permit",
      message: {
        owner,
        spender: this.deployment.settlement,
        value: value.toString(),
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
    };
  }
  async verifyAuthorization(
    request: SigningRequest,
    signature: Hex,
    address: Address,
  ) {
    try {
      return await verifyTypedData({ ...request, address, signature } as any);
    } catch {
      return false;
    }
  }
  permit(signature?: Hex, deadline?: number) {
    if (!signature) return emptyPermit;
    const parsed = parseSignature(signature);
    return {
      deadline: BigInt(deadline!),
      v: Number(parsed.v ?? BigInt(parsed.yParity! + 27)),
      r: parsed.r,
      s: parsed.s,
    };
  }
  async buildTransaction(
    functionName: string,
    args: any[],
    signer: string,
    nonce: number,
    gasPrice?: bigint,
    fixedGas?: bigint,
  ) {
    const wallet = this.wallets[signer];
    if (!wallet)
      throw new AppError(
        503,
        "SIGNER_UNAVAILABLE",
        `${signer} signer is not configured`,
      );
    // fundRelayer is a plain RON transfer to the relayer; issuance steps call the
    // token itself; every other operation targets Settlement.
    const transfer = functionName === "fundRelayer";
    const tokenCall = TOKEN_FUNCTIONS.has(functionName);
    const to = transfer
      ? this.deployment.relayer
      : tokenCall
        ? this.deployment.token
        : this.deployment.settlement;
    const value = transfer ? BigInt(args[0]) : 0n;
    const data: Hex = transfer
      ? "0x"
      : encodeFunctionData({
          abi: artifact(tokenCall ? "CommonCredit" : "Settlement").abi,
          functionName,
          args,
        });
    const gas =
      fixedGas ??
      (transfer
        ? NATIVE_TRANSFER_GAS
        : ((await this.publicClient.estimateGas({
            account: wallet.account.address,
            to,
            data,
          })) *
            12n) /
          10n);
    const raw: Hex = await wallet.signTransaction({
      chain: wallet.chain,
      account: wallet.account,
      to,
      data,
      value,
      gas,
      nonce,
      gasPrice: gasPrice ?? (await this.publicClient.getGasPrice()),
      type: "legacy",
    });
    return { raw, hash: keccak256(raw), nonce };
  }
  async broadcastTransaction(raw: Hex) {
    return this.publicClient.sendRawTransaction({ serializedTransaction: raw });
  }
  async getTransactionStatus(hash: Hex) {
    try {
      return await this.publicClient.getTransactionReceipt({ hash });
    } catch (e: any) {
      if (e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  }
  async readEvents(fromBlock: bigint, toBlock: bigint) {
    return this.publicClient.getLogs({
      address: this.deployment.settlement,
      events: artifact("Settlement").abi.filter((x: any) => x.type === "event"),
      fromBlock,
      toBlock,
    });
  }
  async reconcileOperation(
    kind: string,
    resourceId: string,
    blockNumber: bigint,
  ) {
    const id = chainIdOf(resourceId);
    if (kind === "reward") return this.read("rewards", [id], blockNumber);
    if (kind === "allocate") return this.read("allocations", [id], blockNumber);
    if (kind === "budgetAction") return this.read("actions", [id], blockNumber);
    if (
      ["pay", "claimDelivery", "fulfill", "refund", "resolve"].includes(kind)
    ) {
      const p = await this.read("payments", [id], blockNumber);
      const state = Number(p[5]);
      return kind === "pay"
        ? state > 0
        : kind === "claimDelivery"
          ? state === 2 || state === 3
          : kind === "fulfill"
            ? state === 3
            : state === 4;
    }
    return false;
  }
}
