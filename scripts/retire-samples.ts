import { loadRuntime } from "../src/runtime.js";
import { Store } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { disableAccount, isDisabled } from "../src/auth.js";
import { chainIdOf } from "../src/shared.js";

// Retires the bootstrap sample games and password accounts from an operating
// environment. Their history stays for accounting; the running API worker
// submits the on-chain deactivation that this script queues. Safe to rerun.
const SAMPLE_GAMES = ["game-a", "game-b"];
const SAMPLE_ACCOUNTS = ["operator", "player-001"];

const config = loadRuntime();
const store = new Store(config.database);
try {
  const deployment = store.get(
    "SELECT active_deployment AS id FROM assets",
  )?.id;
  if (!deployment) throw new Error("활성 배포가 없습니다.");
  for (const accountId of SAMPLE_ACCOUNTS) {
    if (!store.get("SELECT 1 FROM accounts WHERE id=?", accountId)) continue;
    if (isDisabled(store, accountId)) continue;
    disableAccount(store, accountId, "sample account retired");
    store.audit("system", "account.disabled", {
      accountId,
      reason: "sample account retired",
    });
    process.stdout.write(`계정 차단: ${accountId}\n`);
  }
  const worker = new Worker(store, new Map());
  for (const gameId of SAMPLE_GAMES) {
    const game = store.get("SELECT * FROM games WHERE id=?", gameId);
    if (
      !game ||
      store.get(
        "SELECT 1 FROM operations WHERE kind='registerGame' AND resource_id=?",
        `retire-sample:${gameId}`,
      )
    )
      continue;
    store.transaction(() => {
      // A fixed resource id makes a rerun return the same queued operation.
      const operationId = worker.queue(
        "registerGame",
        `retire-sample:${gameId}`,
        gameId,
        deployment,
        "admin",
        [chainIdOf(gameId), game.operator_wallet, false],
      );
      store.audit("system", "game.active", {
        gameId,
        active: false,
        reason: "sample game retired",
        operationId,
      });
    });
    process.stdout.write(`게임 운영 중지 접수: ${gameId}\n`);
  }
} finally {
  store.close();
}
