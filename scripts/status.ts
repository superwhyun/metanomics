import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { Store } from "../src/db.js";
import { applyFinalityOverride } from "../src/runtime.js";
const config = JSON.parse(
  readFileSync(process.env.CONFIG_PATH ?? "var/runtime.json", "utf8"),
);
const store = new Store(config.database);
try {
  const active = store.get(
    "SELECT active_deployment FROM assets LIMIT 1",
  ).active_deployment;
  const deployment = applyFinalityOverride(
    JSON.parse(
      store.get("SELECT config FROM deployments WHERE id=?", active).config,
    ),
  );
  const rpc = createPublicClient({ transport: http(deployment.rpcUrl) });
  const head = await rpc.getBlock({ blockTag: "latest" });
  const block =
    deployment.finality === "depth"
      ? await rpc.getBlock({
          blockNumber: head.number! - BigInt(deployment.confirmations!),
        })
      : await rpc.getBlock({
          blockTag: deployment.finality === "local" ? "latest" : "finalized",
        });
  const report = {
    deploymentId: deployment.id,
    chainId: await rpc.getChainId(),
    token: deployment.token,
    settlement: deployment.settlement,
    finality: deployment.finality,
    confirmations: deployment.confirmations,
    finalizedBlock: block.number?.toString(),
    finalizedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    finalityLagSeconds: Math.floor(Date.now() / 1000) - Number(block.timestamp),
    operations: store.all(
      "SELECT o.id,o.kind,o.status,o.error,t.hash,t.block_number FROM operations o LEFT JOIN transaction_attempts t ON t.operation_id=o.id ORDER BY o.rowid,t.rowid",
    ),
    payments: store.all("SELECT id,status,claim_by FROM payments"),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  store.close();
}
