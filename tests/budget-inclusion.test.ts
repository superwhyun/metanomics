import { before, test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../scripts/compile.js";
import { fixture } from "./helpers.js";
import { ASSET, id } from "../src/shared.js";

before(() => {
  compile();
});

test("an allocation is spendable once it is in a block, without waiting for finality", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  const budget = () =>
    f.call(f.credentials["game-a"], "GET", "/v1/games/game-a/budget");
  const start = await budget();
  const anchor = await f.adapter.finalBlock();
  const finalBlock = f.adapter.finalBlock.bind(f.adapter);
  f.adapter.finalBlock = async () => anchor;

  await f.call(f.tokens.admin, "POST", "/v1/allocations", {
    gameId: "game-a",
    assetId: ASSET,
    amount: "100.000000",
    period: id("week"),
    allocationType: "weekly",
  });
  await f.worker.tick();
  await f.worker.tick();
  const included = await budget();
  assert.equal(included.onchain, start.onchain);
  assert.equal(included.incoming, "100.000000");
  assert.equal(Number(included.available), Number(start.available) + 100);
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10.000000",
      rewardRef: id("ref"),
    },
    202,
  );

  f.adapter.finalBlock = finalBlock;
  await f.drain();
  const settled = await budget();
  assert.equal(settled.incoming, "0.000000");
  assert.equal(Number(settled.onchain), Number(start.onchain) + 90);
  assert.equal(settled.available, settled.onchain);
});

test("allocations without a period are each sent, and a retried request is not", async (t) => {
  const f = await fixture(t);
  const allocate = (key: string) =>
    f.call(
      f.tokens.admin,
      "POST",
      "/v1/allocations",
      { gameId: "game-a", assetId: ASSET, amount: "5.000000" },
      202,
      key,
    );
  const first = await allocate("same-click");
  const retry = await allocate("same-click");
  const second = await allocate("next-click");
  assert.equal(retry.allocationId, first.allocationId);
  assert.notEqual(second.allocationId, first.allocationId);
  await f.drain();
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM operations WHERE kind='allocate' AND status='FINALIZED'",
    ).n,
    2,
  );
  const typed = await f.call(
    f.tokens.admin,
    "POST",
    "/v1/allocations",
    {
      gameId: "game-a",
      assetId: ASSET,
      amount: "5.000000",
      allocationType: "weekly",
    },
    422,
  );
  assert.equal(typed.error.code, "ALLOCATION_PERIOD_REQUIRED");
});
