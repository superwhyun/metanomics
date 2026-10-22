import { before, test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../scripts/compile.js";
import { fixture } from "./helpers.js";
import { ASSET } from "../src/shared.js";
import { firstRun, nextRun } from "../src/schedules.js";

before(() => {
  compile();
});

const local = (y: number, m: number, d: number, h = 0) =>
  new Date(y, m - 1, d, h).getTime();

test("schedule days land on the next matching local midnight", () => {
  // 2026-10-21 is a Wednesday.
  const wed = local(2026, 10, 21, 15);
  assert.equal(nextRun("weekly", 1, wed), local(2026, 10, 26));
  assert.equal(nextRun("weekly", 3, wed), local(2026, 10, 28));
  assert.equal(firstRun("weekly", 3, wed), local(2026, 10, 21));
  assert.equal(nextRun("monthly", 15, wed), local(2026, 11, 15));
  assert.equal(nextRun("monthly", 28, wed), local(2026, 10, 28));
  assert.equal(firstRun("monthly", 21, wed), local(2026, 10, 21));
  assert.equal(nextRun("monthly", 5, local(2026, 12, 20)), local(2027, 1, 5));
});

test("a recurring allocation is queued once per period and skipped while paused or off", async (t) => {
  const f = await fixture(t);
  const budget = async () =>
    Number(
      (await f.call(f.credentials["game-a"], "GET", "/v1/games/game-a/budget"))
        .available,
    );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/allocation-schedules",
    {
      gameId: "game-a",
      assetId: ASSET,
      amount: "5",
      cadence: "weekly",
      day: 1,
    },
    403,
  );
  const bad = await f.call(
    f.tokens.admin,
    "POST",
    "/v1/allocation-schedules",
    {
      gameId: "game-a",
      assetId: ASSET,
      amount: "5",
      cadence: "weekly",
      day: 7,
    },
    422,
  );
  assert.equal(bad.error.code, "INVALID_SCHEDULE_DAY");
  const schedule = await f.call(
    f.tokens.admin,
    "POST",
    "/v1/allocation-schedules",
    {
      gameId: "game-a",
      assetId: ASSET,
      amount: "5",
      cadence: "weekly",
      day: 1,
    },
    200,
  );
  assert.equal(schedule.amount, "5.000000");
  const start = await budget();
  const due = schedule.nextRunAt;

  assert.equal(f.runSchedules(due - 1), 0);
  assert.equal(f.runSchedules(due), 1);
  assert.equal(f.runSchedules(due), 0);
  await f.drain();
  assert.equal(await budget(), start + 5);
  const [after] = (
    await f.call(f.tokens.admin, "GET", "/v1/allocation-schedules")
  ).schedules;
  assert.equal(after.nextRunAt, due + 7 * 24 * 3600 * 1000);
  assert.ok(after.lastAllocationId);
  assert.equal(after.lastError, null);

  // A server that was down for three weeks pays one period, not three.
  const late = due + 21 * 24 * 3600 * 1000 + 1000;
  assert.equal(f.runSchedules(late), 1);
  await f.drain();
  assert.equal(await budget(), start + 10);

  await f.call(
    f.tokens.admin,
    "PATCH",
    `/v1/allocation-schedules/${schedule.scheduleId}`,
    { active: false },
    200,
  );
  assert.equal(f.runSchedules(late + 30 * 24 * 3600 * 1000), 0);
  await f.call(
    f.tokens.admin,
    "PATCH",
    `/v1/allocation-schedules/${schedule.scheduleId}`,
    { active: true },
    200,
  );

  await f.call(
    f.tokens.admin,
    "PATCH",
    "/v1/games/game-a",
    { active: false },
    200,
  );
  const resumed = (
    await f.call(f.tokens.admin, "GET", "/v1/allocation-schedules")
  ).schedules[0];
  assert.equal(f.runSchedules(resumed.nextRunAt), 1);
  const skipped = (
    await f.call(f.tokens.admin, "GET", "/v1/allocation-schedules")
  ).schedules[0];
  assert.match(skipped.lastError, /꺼져/);
  assert.ok(skipped.active);
  await f.drain();
  assert.equal(await budget(), start + 10);

  await f.call(
    f.tokens.admin,
    "DELETE",
    `/v1/allocation-schedules/${schedule.scheduleId}`,
    undefined,
    200,
  );
  assert.equal(
    (await f.call(f.tokens.admin, "GET", "/v1/allocation-schedules")).schedules
      .length,
    0,
  );
});
