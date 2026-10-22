import { parseEther } from "viem";
import { loadRuntime, requireExternalDeployment } from "./runtime.js";
import { Store } from "./db.js";
import { EvmAdapter } from "./chain.js";
import { Worker } from "./worker.js";
import { createApi } from "./api.js";
import type { Deployment } from "./shared.js";
import type { Hex } from "viem";
import { acquireWorkerLock } from "./lock.js";

const config = loadRuntime();
const store = new Store(config.database ?? "var/network.sqlite");
const release = acquireWorkerLock(store.path);
process.once("exit", release);
const deployments: Deployment[] = store
  .all("SELECT config FROM deployments")
  .map((row) => JSON.parse(row.config));
if (!deployments.length) throw new Error("등록된 외부 체인 배포가 없습니다.");
for (const deployment of deployments) requireExternalDeployment(deployment);
const adapters = new Map(
  deployments.map((d) => [
    d.id,
    new EvmAdapter(d, {
      relayer: (process.env.RELAYER_PRIVATE_KEY ?? config.relayerKey) as Hex,
      admin: (process.env.ADMIN_PRIVATE_KEY ?? config.adminKey) as
        Hex | undefined,
    }),
  ]),
);
for (const adapter of adapters.values()) await adapter.validate();
// Automatic relayer top-up is on unless RELAYER_AUTO_FUND=0.
const worker = new Worker(
  store,
  adapters,
  process.env.RELAYER_AUTO_FUND === "0"
    ? undefined
    : {
        minWei: parseEther(process.env.RELAYER_MIN_RON ?? "0.5"),
        topupWei: parseEther(process.env.RELAYER_TOPUP_RON ?? "2"),
        adminMinWei: parseEther(process.env.ADMIN_MIN_RON ?? "0.5"),
        intervalMs: 60_000,
      },
);
const app = await createApi(store, worker, {
  origin: process.env.APP_ORIGIN ?? config.origin,
  passwordLogin: process.env.PASSWORD_LOGIN === "1",
  logger: true,
});
const timer = setInterval(() => void worker.tick(), 750);
await app.listen({
  port: Number(process.env.PORT ?? 3300),
  host: process.env.HOST ?? "127.0.0.1",
});
async function close() {
  clearInterval(timer);
  await app.close();
  while (worker.busy) await new Promise((r) => setTimeout(r, 25));
  store.close();
  process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
