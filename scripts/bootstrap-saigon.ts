import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatEther } from "viem";

if (existsSync("var/saigon.env"))
  throw new Error("var/saigon.env already exists; keys are never overwritten");
mkdirSync("var", { recursive: true, mode: 0o700 });
const entries = [
  "ADMIN_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "OPERATOR_PRIVATE_KEY",
].map((name) => [name, generatePrivateKey()] as const);
const client = createPublicClient({
  transport: http("https://saigon-testnet.roninchain.com/rpc"),
});
if ((await client.getChainId()) !== 202601)
  throw new Error("Unexpected testnet chain ID");
writeFileSync(
  "var/saigon.env",
  [
    "RPC_URL=https://saigon-testnet.roninchain.com/rpc",
    "CHAIN_ID=202601",
    "DEPLOYMENT_ID=saigon-v1",
    "CONFIG_PATH=var/saigon-runtime.json",
    "DATABASE_PATH=var/saigon.sqlite",
    ...entries.map(([name, key]) => `${name}=${key}`),
  ].join("\n") + "\n",
  { mode: 0o600 },
);
for (const [name, key] of entries) {
  const address = privateKeyToAccount(key).address;
  process.stdout.write(
    `${name.replace("_PRIVATE_KEY", "")}: ${address} (${formatEther(await client.getBalance({ address }))} test RON)\n`,
  );
}
process.stdout.write(
  "New TESTNET-only keys saved privately in var/saigon.env. Request test RON for ADMIN from the official Ronin faucet.\n",
);
