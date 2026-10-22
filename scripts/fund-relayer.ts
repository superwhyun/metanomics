import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

if (
  process.env.CHAIN_ID !== "202601" ||
  !process.env.ADMIN_PRIVATE_KEY ||
  !process.env.RELAYER_PRIVATE_KEY
)
  throw new Error("Load the dedicated Saigon test configuration first");
const rpcUrl = process.env.RPC_URL!;
const chain = defineChain({
  id: 202601,
  name: "Saigon",
  nativeCurrency: { name: "RON", symbol: "RON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
if ((await client.getChainId()) !== 202601) throw new Error("Unexpected chain");
const account = privateKeyToAccount(process.env.ADMIN_PRIVATE_KEY as Hex),
  to = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex).address;
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
if ((await client.getBalance({ address: to })) < parseEther("0.5")) {
  const hash = await wallet.sendTransaction({ to, value: parseEther("1") });
  await client.waitForTransactionReceipt({ hash });
  process.stdout.write(`Relayer funded with 1 TEST RON: ${hash}\n`);
} else process.stdout.write("Relayer already has test gas.\n");
