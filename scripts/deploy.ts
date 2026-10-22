import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { compile } from "./compile.js";
import { deployContracts, provisionStore } from "../src/provision.js";
import { Store } from "../src/db.js";
import { issueAdminSetupCode } from "../src/auth.js";
import { opaque, json } from "../src/shared.js";
import type { Hex } from "viem";

for (const key of [
  "RPC_URL",
  "CHAIN_ID",
  "DEPLOYMENT_ID",
  "RELAYER_PRIVATE_KEY",
  "ADMIN_PRIVATE_KEY",
  "OPERATOR_PRIVATE_KEY",
])
  if (!process.env[key])
    throw new Error(
      `${key} is required (load .env with node --env-file=.env --import tsx scripts/deploy.ts)`,
    );
const configPath = process.env.CONFIG_PATH ?? "var/runtime.json";
if (existsSync(configPath))
  throw new Error(
    "Runtime configuration already exists; use a separate CONFIG_PATH and DATABASE_PATH for a new deployment",
  );
compile();
mkdirSync("var", { recursive: true, mode: 0o700 });
const keys = {
  admin: process.env.ADMIN_PRIVATE_KEY as Hex,
  relayer: process.env.RELAYER_PRIVATE_KEY as Hex,
  operator: process.env.OPERATOR_PRIVATE_KEY as Hex,
};
const deployment = await deployContracts(
  process.env.RPC_URL!,
  Number(process.env.CHAIN_ID),
  keys,
  {
    id: process.env.DEPLOYMENT_ID,
    finality: "finalized",
    initialSupply: process.env.INITIAL_SUPPLY,
    cap: process.env.SUPPLY_CAP,
  },
);
const database = process.env.DATABASE_PATH ?? "var/network.sqlite";
const store = new Store(database);
const passwords = { admin: opaque(), operator: opaque(), player: opaque() };
const credentials = provisionStore(store, deployment, keys, passwords);
// The installer binds their own wallet to the admin account on first visit.
const setupCode = issueAdminSetupCode(store);
store.close();
// External signer keys remain in environment variables; this file contains no private keys.
writeFileSync(
  configPath,
  json({
    database,
    origin: process.env.APP_ORIGIN ?? "http://localhost:3300",
    credentials,
  }),
  { mode: 0o600 },
);
writeFileSync("var/bootstrap-accounts.json", json(passwords), { mode: 0o600 });
writeFileSync("var/admin-setup-code", `${setupCode}\n`, { mode: 0o600 });
writeFileSync("var/deployment.json", JSON.stringify(deployment, null, 2));
process.stdout.write(
  `Deployment configured: ${deployment.id}\nAddresses: var/deployment.json\nAdmin setup code: ${setupCode} (also in var/admin-setup-code)\nStart the server, open the portal and connect the admin sign-in wallet with this code.\n`,
);
