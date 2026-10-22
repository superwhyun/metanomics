import { before, test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { compile } from "../scripts/compile.js";
import { fixture } from "./helpers.js";

before(() => {
  compile();
});

const balance = (f: any, address: string): Promise<bigint> =>
  f.adapter.publicClient.getBalance({ address });

test("admin moves RON to the relayer through a queued transfer that keeps the admin reserve", async (t) => {
  const f = await fixture(t);
  const before = await balance(f, f.deployment.relayer);
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/relayer-fundings",
    { amount: "1.5" },
    403,
  );
  for (const amount of ["abc", "0", "-1", "1.0000000000000000001"])
    await f.call(
      f.tokens.admin,
      "POST",
      "/v1/relayer-fundings",
      { amount },
      422,
    );
  const admin = await balance(f, f.deployment.admin);
  const tooMuch = await f.call(
    f.tokens.admin,
    "POST",
    "/v1/relayer-fundings",
    { amount: (Number(admin / 10n ** 18n) + 1).toString() },
    422,
  );
  assert.equal(tooMuch.error.code, "ADMIN_RESERVE_REQUIRED");

  const funding = await f.call(f.tokens.admin, "POST", "/v1/relayer-fundings", {
    amount: "1.5",
  });
  await f.drain();
  assert.equal(
    f.store.get(
      "SELECT kind,status FROM operations WHERE id=?",
      funding.operationId,
    ).status,
    "FINALIZED",
  );
  assert.equal(
    await balance(f, f.deployment.relayer),
    before + parseEther("1.5"),
  );
  const overview = await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
  assert.equal(
    overview.relayerFunding.recent[0].amountWei,
    parseEther("1.5").toString(),
  );
  assert.equal(overview.relayerFunding.recent[0].trigger, "manual");
});

test("the worker tops up a low relayer once per pending transfer and warns when the admin reserve is short", async (t) => {
  const f = await fixture(t);
  const before = await balance(f, f.deployment.relayer);
  f.worker.funding = {
    minWei: before + 1n,
    topupWei: parseEther("2"),
    adminMinWei: parseEther("0.5"),
    intervalMs: 0,
  };
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(
    f.store.all("SELECT id FROM operations WHERE kind='fundRelayer'").length,
    1,
  );
  await f.drain();
  assert.equal(
    await balance(f, f.deployment.relayer),
    before + parseEther("2"),
  );
  await f.worker.tick();
  assert.equal(
    f.store.all("SELECT id FROM operations WHERE kind='fundRelayer'").length,
    1,
  );

  f.worker.funding = {
    minWei: parseEther("1000000"),
    topupWei: parseEther("2"),
    adminMinWei: parseEther("1000000000"),
    intervalMs: 0,
  };
  await f.worker.tick();
  assert.equal(
    f.store.all("SELECT id FROM operations WHERE kind='fundRelayer'").length,
    1,
  );
  assert.match(f.worker.fundingWarning ?? "", /관리자 지갑/);
  const overview = await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
  assert.match(overview.relayerFunding.warning, /관리자 지갑/);
  assert.equal(
    overview.relayerFunding.auto.topupWei,
    parseEther("2").toString(),
  );
  assert.equal(overview.relayerFunding.recent[0].trigger, "auto");
});
