import { before, test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../scripts/compile.js";
import { fixture } from "./helpers.js";
import { ASSET, chainIdOf, id } from "../src/shared.js";

before(() => {
  compile();
});

test("switching a game off and on is immediate, needs no transaction and blocks new rewards", async (t) => {
  const f = await fixture(t);
  const catalog = async () =>
    (await f.call(null, "GET", "/v1/games")).games.map((g: any) => g.id);
  const operations = () =>
    f.store.all("SELECT id FROM operations WHERE kind='registerGame'").length;
  const before = operations();
  await f.call(
    f.tokens.operator,
    "PATCH",
    "/v1/games/game-a",
    { active: false },
    403,
  );
  const off = await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: false },
    200,
  );
  assert.deepEqual(off, { gameId: "game-a", active: false });
  assert.deepEqual(await catalog(), ["game-b"]);
  assert.equal(operations(), before);
  const refused = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "1.000000",
      rewardRef: id("ref"),
    },
    409,
  );
  assert.equal(refused.error.code, "GAME_INACTIVE");
  await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: true },
    200,
  );
  assert.deepEqual((await catalog()).sort(), ["game-a", "game-b"]);
  assert.equal(operations(), before);
});

test("a game stopped in the contract cannot be switched back on from the portal", async (t) => {
  const f = await fixture(t);
  f.worker.queue(
    "registerGame",
    "retire:game-a",
    "game-a",
    f.deployment.id,
    "admin",
    [
      chainIdOf("game-a"),
      f.store.get("SELECT operator_wallet FROM games WHERE id='game-a'")
        .operator_wallet,
      false,
    ],
  );
  await f.drain();
  const refused = await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: true },
    409,
  );
  assert.equal(refused.error.code, "GAME_INACTIVE_ONCHAIN");
});

test("deleting a stopped game forgets it in the portal but keeps its money history", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  await f.call(f.tokens.admin, "DELETE", "/v1/games/game-a", undefined, 409);
  await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: false },
    200,
  );
  await f.call(f.tokens.operator, "DELETE", "/v1/games/game-a", undefined, 403);

  // An unfinished payment keeps a game from being forgotten, and a game switched
  // off no longer accepts a new payment authorization.
  const pending = await f.payment();
  await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-b",
    { active: false },
    200,
  );
  const stopped = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pending.paymentId}/authorizations`,
    { signature: `0x${"11".repeat(65)}` },
    409,
  );
  assert.equal(stopped.error.code, "GAME_INACTIVE");
  const open = await f.call(
    f.tokens.admin,
    "DELETE",
    "/v1/games/game-b",
    undefined,
    409,
  );
  assert.equal(open.error.code, "GAME_HAS_OPEN_PAYMENTS");

  const deleted = await f.call(
    f.tokens.admin,
    "DELETE",
    "/v1/games/game-a",
    undefined,
    200,
  );
  assert.deepEqual(deleted, { gameId: "game-a", deleted: true });
  for (const table of [
    "games",
    "game_profiles",
    "game_credentials",
    "player_links",
  ])
    assert.equal(
      f.store.all(
        `SELECT 1 FROM ${table} WHERE ${table === "games" ? "id" : "game_id"}='game-a'`,
      ).length,
      0,
      table,
    );
  await f.call(
    f.credentials["game-a"],
    "GET",
    "/v1/games/game-a/budget",
    undefined,
    401,
  );
  assert.ok(
    !(await f.call(f.tokens.admin, "GET", "/v1/admin/overview")).games.some(
      (g: any) => g.id === "game-a",
    ),
  );
  assert.equal(
    f.store.all("SELECT 1 FROM rewards WHERE game_id='game-a'").length,
    1,
  );
  await f.call(f.tokens.admin, "DELETE", "/v1/games/game-a", undefined, 404);
});

test("recording a stop or resume on chain is a separate action and never switches the portal on", async (t) => {
  const f = await fixture(t);
  const onchain = async () =>
    (
      (await f.adapter.read("games", [chainIdOf("game-a")])) as [
        string,
        boolean,
      ]
    )[1];
  const overviewGame = async () =>
    (await f.call(f.tokens.admin, "GET", "/v1/admin/overview")).games.find(
      (g: any) => g.id === "game-a",
    );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/chain-state",
    { active: false },
    403,
  );
  await f.call(f.tokens.admin, "POST", "/v1/games/game-a/chain-state", {
    active: false,
  });
  const pending = await f.call(
    f.tokens.admin,
    "POST",
    "/v1/games/game-a/chain-state",
    { active: false },
    409,
  );
  assert.equal(pending.error.code, "CHAIN_STATE_PENDING");
  assert.equal((await overviewGame()).chainPending, true);
  await f.drain();
  assert.equal(await onchain(), false);
  const stopped = await overviewGame();
  assert.equal(stopped.chainActive, false);
  assert.equal(stopped.active, 0);

  await f.call(f.tokens.admin, "POST", "/v1/games/game-a/chain-state", {
    active: true,
  });
  await f.drain();
  assert.equal(await onchain(), true);
  assert.equal((await overviewGame()).active, 0);
  await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: true },
    200,
  );
  assert.equal((await overviewGame()).active, 1);
});
