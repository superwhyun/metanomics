import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact } from "./contracts.js";
import { Store } from "./db.js";
import { passwordHash } from "./auth.js";
import {
  ASSET,
  amount,
  json,
  opaque,
  sha,
  chainIdOf,
  type Deployment,
} from "./shared.js";

export const DEVELOPMENT_MNEMONIC =
  "test test test test test test test test test test test junk";
export type ProvisionKeys = {
  admin: Hex;
  relayer: Hex;
  operator: Hex;
  player?: Hex;
};
export async function deployContracts(
  rpcUrl: string,
  chainId: number,
  keys: ProvisionKeys,
  settings: {
    id?: string;
    finality?: "local" | "finalized" | "depth";
    confirmations?: number;
    initialSupply?: string;
    cap?: string;
  } = {},
): Promise<Deployment> {
  const admin = privateKeyToAccount(keys.admin),
    relayer = privateKeyToAccount(keys.relayer);
  if (
    admin.address === relayer.address ||
    admin.address === privateKeyToAccount(keys.operator).address ||
    relayer.address === privateKeyToAccount(keys.operator).address
  )
    throw new Error("Admin, relayer, and operator must be separate wallets");
  const chain = defineChain({
    id: chainId,
    name: "Deployment",
    nativeCurrency: { name: "RON", symbol: "RON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  if ((await publicClient.getChainId()) !== chainId)
    throw new Error("RPC chain mismatch");
  const wallet = createWalletClient({
    account: admin,
    chain,
    transport: http(rpcUrl),
  });
  const tokenArtifact = artifact("CommonCredit");
  const settlementArtifact = artifact("Settlement");
  const initialSupply = amount(settings.initialSupply ?? "1000000"),
    cap = amount(settings.cap ?? "10000000");
  if (initialSupply > cap) throw new Error("Initial supply exceeds cap");
  const tokenHash = await wallet.deployContract({
    ...tokenArtifact,
    args: [admin.address, initialSupply, cap],
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({
    hash: tokenHash,
  });
  if (!tokenReceipt.contractAddress || tokenReceipt.status !== "success")
    throw new Error("Token deployment failed");
  const token = tokenReceipt.contractAddress;
  const claimWindow = chainId === 31337 ? 900 : 3600;
  const settlementHash = await wallet.deployContract({
    ...settlementArtifact,
    args: [token, admin.address, relayer.address, BigInt(claimWindow)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: settlementHash,
  });
  if (!receipt.contractAddress || receipt.status !== "success")
    throw new Error("Settlement deployment failed");
  const settlement = receipt.contractAddress;
  const send = async (
    address: Hex,
    abi: any,
    functionName: string,
    args: any[],
  ) => {
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`${functionName} reverted`);
    return hash;
  };
  await send(token, tokenArtifact.abi, "approve", [settlement, initialSupply]);
  await send(settlement, settlementArtifact.abi, "fundReserve", [
    initialSupply,
  ]);
  for (const gameId of ["game-a", "game-b"])
    await send(settlement, settlementArtifact.abi, "registerGame", [
      chainIdOf(gameId),
      privateKeyToAccount(keys.operator).address,
      true,
    ]);
  return {
    id: settings.id ?? "local-v1",
    chainId,
    rpcUrl,
    token,
    settlement,
    admin: admin.address,
    relayer: relayer.address,
    fromBlock: receipt.blockNumber.toString(),
    finality: settings.finality ?? (chainId === 31337 ? "local" : "finalized"),
    ...(settings.finality === "depth"
      ? { confirmations: settings.confirmations }
      : {}),
    authorizationWindowSeconds: claimWindow,
    claimWindowSeconds: claimWindow,
  };
}
export function provisionStore(
  store: Store,
  deployment: Deployment,
  keys: ProvisionKeys,
  passwords: { admin: string; operator: string; player: string },
) {
  const operator = privateKeyToAccount(keys.operator).address;
  const accounts = [
    ["admin", "admin", "admin", deployment.admin, passwords.admin],
    ["operator", "operator", "operator", operator, passwords.operator],
    ["player-001", "player", "player", null, passwords.player],
  ];
  store.transaction(() => {
    const existing = store.get(
      "SELECT config FROM deployments WHERE id=?",
      deployment.id,
    );
    if (existing && existing.config !== json(deployment))
      throw new Error("Deployment IDs are immutable");
    store.run(
      "INSERT OR IGNORE INTO deployments VALUES(?,?)",
      deployment.id,
      json(deployment),
    );
    store.run(
      "INSERT OR IGNORE INTO assets VALUES(?,?,?)",
      ASSET,
      6,
      deployment.id,
    );
    for (const [id, username, role, wallet, password] of accounts)
      store.run(
        "INSERT OR IGNORE INTO accounts VALUES(?,?,?,?,?)",
        id,
        username,
        passwordHash(password!),
        role,
        wallet,
      );
    store.run("INSERT OR IGNORE INTO players VALUES(?)", "player-001");
    for (const [gameId, name] of [
      ["game-a", "Orbit Sprint"],
      ["game-b", "Star Harbor"],
    ])
      store.run(
        "INSERT OR IGNORE INTO games VALUES(?,?,?,?,1)",
        gameId,
        name,
        "operator",
        operator,
      );
  });
  store.seedDemoProfiles();
  const credentials: Record<string, string> = {};
  for (const gameId of ["game-a", "game-b"]) {
    const token = opaque();
    credentials[gameId] = token;
    store.run(
      "INSERT INTO game_credentials(id,game_id,token_hash,scopes,label,created_at) VALUES(?,?,?,?,?,?)",
      `boot-${opaque()}`,
      gameId,
      sha(token),
      json(["links", "budget", "rewards", "payments", "events"]),
      "예제 게임 서버",
      Date.now(),
    );
  }
  return credentials;
}
