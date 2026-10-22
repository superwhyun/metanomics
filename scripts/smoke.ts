import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Store } from "../src/db.js";
import { EvmAdapter } from "../src/chain.js";
import { Worker } from "../src/worker.js";
import { createApi } from "../src/api.js";
import { DemoGame, NetworkClient } from "../src/game.js";
import { ASSET, id, json, display, amount } from "../src/shared.js";
import type { Hex } from "viem";
import { acquireWorkerLock } from "../src/lock.js";

const configPath = process.env.CONFIG_PATH ?? "var/runtime.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
const store = new Store(config.database);
const release = acquireWorkerLock(store.path);
process.once("exit", release);
const activeId = store.get(
  "SELECT active_deployment FROM assets WHERE id=?",
  ASSET,
).active_deployment;
const deployment = JSON.parse(
  store.get("SELECT config FROM deployments WHERE id=?", activeId).config,
);
const adapter = new EvmAdapter(deployment, {
  relayer: (process.env.RELAYER_PRIVATE_KEY ?? config.relayerKey) as Hex,
  admin: (process.env.ADMIN_PRIVATE_KEY ?? config.adminKey) as Hex,
});
await adapter.validate();
const worker = new Worker(store, new Map([[deployment.id, adapter]]));
const app = await createApi(store, worker, { staticFiles: false });
const base = await app.listen({ port: 0, host: "127.0.0.1" });
const passwords =
  deployment.finality === "local"
    ? { admin: "admin-dev", operator: "operator-dev", player: "player-dev" }
    : JSON.parse(readFileSync("var/bootstrap-accounts.json", "utf8"));
const root = join(
  process.env.SMOKE_OUTPUT_DIR ?? "var",
  `smoke-${deployment.id}`,
);
mkdirSync(root, { recursive: true, mode: 0o700 });
const reportPath = join(root, "report.json");
const saved = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : null;
const resume = saved && !saved.completedAt ? saved : null;
const runId = resume?.runId ?? id("smoke");
// This is a test CLIENT wallet. No API accepts this key.
const keyPath = join(root, "player.key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, generatePrivateKey(), { mode: 0o600 });
const player = privateKeyToAccount(readFileSync(keyPath, "utf8") as Hex);
const report: any = resume ?? {
  runId,
  deployment,
  startedAt: new Date().toISOString(),
  steps: [],
  results: {},
};
delete report.error;
const save = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
save();
let gameA: DemoGame | undefined, gameB: DemoGame | undefined;
const call = async (
  token: string | undefined,
  path: string,
  body?: any,
  key = id("request"),
) => {
  const response = await fetch(`${base}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined
      ? {}
      : {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: json(body),
        }),
  });
  const result: any = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${json(result)}`);
  return result;
};
const drain = async (label: string, resourceId: string, kind: string) => {
  const started = Date.now();
  let announced = 0;
  for (;;) {
    await worker.tick();
    const ops = store.all(
      "SELECT id,kind,status,error FROM operations WHERE resource_id=? AND kind=? AND status NOT IN ('FINALIZED','FAILED')",
      resourceId,
      kind,
    );
    const failed = store.all(
      "SELECT id,kind,error FROM operations WHERE resource_id=? AND kind=? AND status='FAILED'",
      resourceId,
      kind,
    );
    if (failed.length) throw new Error(json(failed));
    if (!ops.length) {
      report.steps.push({ label, elapsedMs: Date.now() - started });
      delete report.pending;
      save();
      return;
    }
    if (Date.now() - announced > 30_000) {
      process.stdout.write(
        `${label}: ${json(ops.map((o) => ({ kind: o.kind, status: o.status })))} (${Math.floor((Date.now() - started) / 1000)}s)\n`,
      );
      announced = Date.now();
      report.pending = {
        label,
        operations: ops,
        workerError: worker.lastError,
        updatedAt: new Date().toISOString(),
      };
      save();
    }
    if (
      Date.now() - started >
      Number(process.env.SMOKE_FINALITY_TIMEOUT_MS ?? 3 * 60 * 60_000)
    )
      throw new Error(
        `Finality wait limit reached; rerun this command to resume: ${label}`,
      );
    await new Promise((r) =>
      setTimeout(r, deployment.finality === "local" ? 50 : 3000),
    );
  }
};
try {
  const admin = (
    await call(undefined, "/sessions", {
      username: "admin",
      password: passwords.admin,
    })
  ).token;
  const token = (
    await call(undefined, "/sessions", {
      username: "player",
      password: passwords.player,
    })
  ).token;
  const proof = await call(token, "/wallet-links/challenges", {
    address: player.address,
    deploymentId: deployment.id,
  });
  await call(token, "/wallet-links", {
    challengeId: proof.challengeId,
    signature: await player.signMessage({ message: proof.message }),
  });
  const before = report.before
    ? (Object.fromEntries(
        Object.entries(report.before).map(([key, value]) => [
          key,
          String(value) === "0.000000" ? 0n : amount(String(value)),
        ]),
      ) as { player: bigint; a: bigint; b: bigint })
    : {
        player: await adapter.getBalance(player.address),
        a: await adapter.getGameBudget("game-a"),
        b: await adapter.getGameBudget("game-b"),
      };
  report.before = Object.fromEntries(
    Object.entries(before).map(([key, value]) => [key, display(value)]),
  );
  save();
  if (!report.supplyAtDeployment) {
    report.supplyAtDeployment = display(
      await adapter.publicClient.readContract({
        address: deployment.token,
        abi: (await import("../src/contracts.js")).artifact("CommonCredit").abi,
        functionName: "totalSupply",
        blockNumber: BigInt(deployment.fromBlock),
      }),
    );
    save();
  }
  const allocation = await call(admin, "/allocations", {
    gameId: "game-a",
    period: runId,
    allocationType: "additional",
    allocationRef: runId,
    assetId: ASSET,
    amount: "100.000000",
  });
  await drain("allocate 100", allocation.allocationId, "allocate");
  gameA = new DemoGame(
    "game-a",
    join(root, "a.sqlite"),
    new NetworkClient(base, config.credentials["game-a"]),
  );
  gameB = new DemoGame(
    "game-b",
    join(root, "b.sqlite"),
    new NetworkClient(base, config.credentials["game-b"]),
  );
  for (const game of [gameA, gameB]) {
    const code = await call(token, "/player-links/codes", {
      gameId: game.gameId,
    });
    const connected = await game.network.call("/player-links/exchange", {
      code: code.code,
      gamePlayerId: "pilot",
    });
    game.run(
      "UPDATE accounts SET player_id=? WHERE id=?",
      connected.playerId,
      "pilot",
    );
  }
  const rewardBody = {
    playerId: "player-001",
    assetId: ASSET,
    amount: "10.000000",
    rewardRef: `${runId}:ranking`,
  };
  const reward = await gameA.network.call(
    "/games/game-a/rewards",
    rewardBody,
    `${runId}:reward`,
  );
  const duplicate = await gameA.network.call(
    "/games/game-a/rewards",
    rewardBody,
    `${runId}:reward-again`,
  );
  assert.equal(reward.rewardId, duplicate.rewardId);
  await drain("reward 10", reward.rewardId, "reward");
  const orderId = `${runId}:order`;
  const order = {
    playerId: "player-001",
    orderId,
    assetId: ASSET,
    amount: "4.000000",
    item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
  };
  gameB.run(
    "INSERT OR IGNORE INTO orders VALUES(?,?,?)",
    orderId,
    "pilot",
    json(order),
  );
  const pay = await gameB.network.call(
    "/games/game-b/payments",
    order,
    orderId,
  );
  const details = await call(token, `/payments/${pay.paymentId}`);
  if (details.status === "CREATED")
    await call(token, `/payments/${pay.paymentId}/authorizations`, {
      signature: await player.signTypedData(details.authorization),
      permitSignature: await player.signTypedData(details.permit),
      permitDeadline: details.expiresAt,
    });
  await drain("pay 4", pay.paymentId, "pay");
  const beforeClaim = await call(token, `/payments/${pay.paymentId}`);
  if (beforeClaim.status === "PAID")
    await gameB.network.call(
      `/payments/${pay.paymentId}/delivery-claims`,
      {},
      `claim:${pay.paymentId}`,
    );
  await drain("claim delivery", pay.paymentId, "claimDelivery");
  if (
    !gameB.get(
      "SELECT * FROM deliveries WHERE payment_id=? AND status='DELIVERED'",
      pay.paymentId,
    )
  ) {
    gameB.afterGrant = () => {
      throw new Error("intentional post-grant interruption");
    };
    await gameB.tick();
    assert.match(gameB.lastError!, /intentional/);
  }
  gameB.close();
  gameB = new DemoGame(
    "game-b",
    join(root, "b.sqlite"),
    new NetworkClient(base, config.credentials["game-b"]),
  );
  await gameB.tick();
  await drain("fulfill after game restart", pay.paymentId, "fulfill");
  const bonus = await gameB.network.call(
    "/games/game-b/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "1.000000",
      rewardRef: `${runId}:bonus`,
    },
    `${runId}:bonus`,
  );
  await drain("reward 1", bonus.rewardId, "reward");
  const after = {
    player: await adapter.getBalance(player.address),
    a: await adapter.getGameBudget("game-a"),
    b: await adapter.getGameBudget("game-b"),
  };
  assert.equal(after.player - before.player, amount("7"));
  assert.equal(after.a - before.a, amount("90"));
  assert.equal(after.b - before.b, amount("3"));
  assert.equal(
    gameB.get(
      "SELECT COUNT(*) AS n FROM deliveries WHERE payment_id=?",
      pay.paymentId,
    ).n,
    1,
  );
  const finalPay = await call(token, `/payments/${pay.paymentId}`);
  assert.equal(finalPay.status, "COMPLETED");
  const supply = await adapter.publicClient.readContract({
    address: deployment.token,
    abi: (await import("../src/contracts.js")).artifact("CommonCredit").abi,
    functionName: "totalSupply",
  });
  assert.equal(display(supply), report.supplyAtDeployment);
  report.results = {
    ...Object.fromEntries(
      Object.entries(after).map(([key, value]) => [key, display(value)]),
    ),
    itemGrants: 1,
    paymentStatus: finalPay.status,
    totalSupply: display(supply),
    playerWallet: player.address,
    allocationId: allocation.allocationId,
    rewardId: reward.rewardId,
    paymentId: pay.paymentId,
    bonusId: bonus.rewardId,
  };
  report.transactions = await Promise.all(
    store
      .all(
        "SELECT t.hash,t.nonce,o.kind FROM transaction_attempts t JOIN operations o ON o.id=t.operation_id WHERE o.resource_id IN (?,?,?,?) ORDER BY t.rowid",
        allocation.allocationId,
        reward.rewardId,
        pay.paymentId,
        bonus.rewardId,
      )
      .map(async (row) => {
        const receipt = await adapter.publicClient.getTransactionReceipt({
          hash: row.hash,
        });
        return {
          ...row,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          executionFeeWei: (
            receipt.gasUsed * receipt.effectiveGasPrice
          ).toString(),
          // OP Stack RPC receipts expose this in addition to execution gas.
          l1FeeWei:
            receipt.l1Fee === undefined
              ? null
              : BigInt(receipt.l1Fee).toString(),
        };
      }),
  );
  report.gasTotals = {
    gasUsed: report.transactions
      .reduce((sum: bigint, tx: any) => sum + BigInt(tx.gasUsed), 0n)
      .toString(),
    executionFeeWei: report.transactions
      .reduce((sum: bigint, tx: any) => sum + BigInt(tx.executionFeeWei), 0n)
      .toString(),
    l1FeeWei: report.transactions.every((tx: any) => tx.l1FeeWei !== null)
      ? report.transactions
          .reduce((sum: bigint, tx: any) => sum + BigInt(tx.l1FeeWei), 0n)
          .toString()
      : null,
  };
  report.completedAt = new Date().toISOString();
  writeFileSync(
    join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    `PASS ${deployment.id}: ${json(report.results)}\nReport: ${join(root, "report.json")}\n`,
  );
} catch (error: any) {
  report.error = error.message;
  writeFileSync(
    join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  await app.close();
  gameA?.close();
  gameB?.close();
  store.close();
  release();
}
