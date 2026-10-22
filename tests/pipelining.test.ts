import { before, test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";
import { ASSET, display } from "../src/shared.js";

before(() => {
  compile();
});

async function twoRewards(f: any) {
  const ids = [];
  for (const rewardRef of ["pipe-1", "pipe-2"])
    ids.push(
      (
        await f.call(
          f.credentials["game-a"],
          "POST",
          "/v1/games/game-a/rewards",
          {
            playerId: "player-001",
            assetId: ASSET,
            amount: "10",
            rewardRef,
          },
        )
      ).operationId,
    );
  return ids;
}
const statuses = (f: any, ids: string[]) =>
  ids.map(
    (id) => f.store.get("SELECT status FROM operations WHERE id=?", id).status,
  );

test("the relayer sends the next transaction once the previous one is in a block, without waiting for finality", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const anchor = await f.adapter.finalBlock();
  const finalBlock = f.adapter.finalBlock.bind(f.adapter);
  f.adapter.finalBlock = async () => anchor;
  const ids = await twoRewards(f);
  await f.worker.tick();
  await f.worker.tick();
  assert.deepEqual(statuses(f, ids), ["INCLUDED", "INCLUDED"]);
  const nonces = ids.map(
    (id) =>
      f.store.get(
        "SELECT nonce FROM transaction_attempts WHERE operation_id=?",
        id,
      ).nonce,
  );
  assert.equal(nonces[1], nonces[0] + 1);
  // Business state still waits for finality.
  assert.equal(
    f.store.all("SELECT 1 FROM event_outbox WHERE type='reward.finalized'")
      .length,
    0,
  );
  f.adapter.finalBlock = finalBlock;
  await f.drain();
  assert.deepEqual(statuses(f, ids), ["FINALIZED", "FINALIZED"]);
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "20.000000",
  );
});

test("a reorg that drops pipelined transactions replays the same signed transactions in nonce order once", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const anchor = await f.adapter.finalBlock();
  const snapshot = await f.chain.client.request({
    method: "evm_snapshot",
    params: [],
  } as any);
  const finalBlock = f.adapter.finalBlock.bind(f.adapter);
  f.adapter.finalBlock = async () => anchor;
  const ids = await twoRewards(f);
  await f.worker.tick();
  await f.worker.tick();
  assert.deepEqual(statuses(f, ids), ["INCLUDED", "INCLUDED"]);
  const hashes = ids.map(
    (id) =>
      f.store.get(
        "SELECT hash FROM transaction_attempts WHERE operation_id=?",
        id,
      ).hash,
  );
  await f.chain.client.request({
    method: "evm_revert",
    params: [snapshot],
  } as any);
  f.adapter.finalBlock = finalBlock;
  await f.drain();
  assert.deepEqual(statuses(f, ids), ["FINALIZED", "FINALIZED"]);
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "20.000000",
  );
  assert.deepEqual(
    ids.map(
      (id) =>
        f.store.get(
          "SELECT hash FROM transaction_attempts WHERE operation_id=? AND status='FINALIZED'",
          id,
        )?.hash,
    ),
    hashes,
  );
});
