import { before, test } from "node:test";
import assert from "node:assert/strict";
import { playerBalance } from "../src/player-balance.js";
import { ASSET, UNIT } from "../src/shared.js";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";

before(() => compile());

test("a mined reward appears in the latest wallet balance before finality, and is removed again after a reorg", async (t) => {
  const f = await fixture(t);
  const missingWallet = (
    await f.call(f.tokens.player, "GET", "/v1/players/me/balances")
  ).balances[0];
  assert.equal(missingWallet.walletRequired, true);
  assert.equal(missingWallet.latestAmount, undefined);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const anchor = await f.adapter.finalBlock();
  const snapshot = await f.chain.client.request({
    method: "evm_snapshot",
    params: [],
  } as any);
  const original = f.adapter.finalBlock.bind(f.adapter);
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      recipient: accounts.player.address,
      assetId: ASSET,
      amount: "10.000000",
      rewardRef: "live-balance",
    },
  );
  f.adapter.finalBlock = async () => anchor;
  await f.worker.tick();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", reward.operationId)
      .status,
    "INCLUDED",
  );
  const balance = async () =>
    (await f.call(f.tokens.player, "GET", "/v1/players/me/balances"))
      .balances[0];
  const included = await balance();
  assert.equal(included.latestAmount, "10.000000");
  assert.equal(included.amount, "0.000000");
  assert.equal(included.pendingDelta, "10.000000");
  assert.equal(included.finalized, true);
  assert.ok(BigInt(included.latestBlockNumber) > BigInt(included.blockNumber));
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='reward.finalized'")
      .length,
    0,
  );
  await f.call(
    f.tokens.operator,
    "GET",
    "/v1/players/me/balances",
    undefined,
    403,
  );
  await f.call(null, "GET", "/v1/players/me/balances", undefined, 401);

  await f.chain.client.request({
    method: "evm_revert",
    params: [snapshot],
  } as any);
  assert.equal((await balance()).latestAmount, "0.000000");
  assert.equal((await balance()).pendingDelta, "0.000000");
  f.adapter.finalBlock = original;
  await f.drain();
  const settled = await balance();
  assert.equal(settled.latestAmount, "10.000000");
  assert.equal(settled.amount, "10.000000");
  assert.equal(settled.pendingDelta, "0.000000");
});

test("a balance snapshot pins both reads and preserves negative sub-unit changes without floating point arithmetic", async () => {
  const reads: bigint[] = [];
  const snapshot = await playerBalance(
    {
      latestBlock: async () => ({ number: 12n }),
      finalBlock: async () => ({ number: 10n }),
      getBalance: async (_address, block) => {
        reads.push(block!);
        return block === 12n ? 1_000_001n : 2_500_002n;
      },
    },
    accounts.player.address,
  );
  assert.deepEqual(
    reads.sort((a, b) => Number(a - b)),
    [10n, 12n],
  );
  assert.equal(snapshot.latestAmount, "1.000001");
  assert.equal(snapshot.amount, "2.500002");
  assert.equal(snapshot.pendingDelta, "-1.500001");
});

test("missing latest or finality RPC data stays explicitly unavailable instead of fabricating zero or a pending total", async () => {
  const failing = async () => {
    throw new Error("RPC unavailable");
  };
  const base = {
    latestBlock: async () => ({ number: 12n }),
    finalBlock: async () => ({ number: 10n }),
    getBalance: async () => 7n * UNIT,
  };
  const noFinality = await playerBalance(
    { ...base, finalBlock: failing },
    accounts.player.address,
  );
  assert.equal(noFinality.latestAmount, "7.000000");
  assert.equal(noFinality.amount, undefined);
  assert.equal(noFinality.pendingDelta, undefined);
  assert.equal(noFinality.finalityUnavailable, true);
  assert.equal(noFinality.finalized, false);
  const noLatest = await playerBalance(
    { ...base, latestBlock: failing },
    accounts.player.address,
  );
  assert.equal(noLatest.latestAmount, undefined);
  assert.equal(noLatest.amount, "7.000000");
  assert.equal(noLatest.pendingDelta, undefined);
  assert.equal(noLatest.latestUnavailable, true);
  const noData = await playerBalance(
    { ...base, getBalance: failing },
    accounts.player.address,
  );
  assert.equal(noData.latestAmount, undefined);
  assert.equal(noData.amount, undefined);
  assert.equal(noData.latestUnavailable, true);
  assert.equal(noData.finalityUnavailable, true);
});

test("a newer final snapshot overtaking an in-flight latest read does not invent a negative change", async () => {
  const result = await playerBalance(
    {
      latestBlock: async () => ({ number: 10n }),
      finalBlock: async () => ({ number: 11n }),
      getBalance: async (_address, block) => (block === 10n ? 0n : 10n * UNIT),
    },
    accounts.player.address,
  );
  assert.equal(result.latestBlockNumber, "11");
  assert.equal(result.latestAmount, "10.000000");
  assert.equal(result.pendingDelta, "0.000000");
});
