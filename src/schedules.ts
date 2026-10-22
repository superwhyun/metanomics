// Recurring budget allocations: an admin sets "N CGC to a game every week or
// month" once, and the server queues each period's allocation on its own.
import type { Store } from "./db.js";
import type { Worker } from "./worker.js";
import { canonical, chainIdOf, display, id, json, sha } from "./shared.js";

export type Cadence = "weekly" | "monthly";
export interface ScheduleRow {
  id: string;
  game_id: string;
  amount: string;
  cadence: Cadence;
  day: number;
  active: number;
  next_run_at: number;
  last_run_at: number | null;
  last_allocation_id: string | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
}

// Monthly runs stop at the 28th so every month has the day.
export const MONTHLY_LAST_DAY = 28;

const midnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};

// The first local midnight after `after` that falls on the scheduled day.
export function nextRun(cadence: Cadence, day: number, after: number): number {
  const d = midnight(after);
  if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  if (cadence === "weekly") {
    d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7));
    return d.getTime();
  }
  if (d.getDate() > day) d.setMonth(d.getMonth() + 1, 1);
  d.setDate(day);
  return d.getTime();
}

// The first run of a new or resumed schedule: today counts when it matches.
export const firstRun = (cadence: Cadence, day: number, now: number) =>
  nextRun(cadence, day, midnight(now).getTime() - 1);

const runKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface AllocationInput {
  actorId: string;
  gameId: string;
  deploymentId: string;
  value: bigint;
  ref: string;
  body: unknown;
}

// Shared by the one-off route and the scheduler. The business reference makes
// a repeated call return the allocation it already queued.
export function queueAllocation(
  store: Store,
  worker: Worker,
  input: AllocationInput,
): { allocationId: string; operationId: string; created: boolean } {
  const old = store.get(
    "SELECT id FROM allocations WHERE game_id=? AND business_ref=?",
    input.gameId,
    input.ref,
  );
  if (old)
    return {
      allocationId: old.id,
      operationId: store.get(
        "SELECT id FROM operations WHERE kind='allocate' AND resource_id=?",
        old.id,
      )?.id,
      created: false,
    };
  const allocationId = id("allocation");
  store.run(
    "INSERT INTO allocations VALUES(?,?,?,?,?)",
    allocationId,
    input.gameId,
    input.ref,
    sha(canonical(input.body)),
    json(input.body),
  );
  const operationId = worker.queue(
    "allocate",
    allocationId,
    input.gameId,
    input.deploymentId,
    "admin",
    [chainIdOf(allocationId), chainIdOf(input.gameId), input.value.toString()],
  );
  store.audit(input.actorId, "allocation.create", {
    allocationId,
    ...(input.body as object),
  });
  return { allocationId, operationId, created: true };
}

// Queues every schedule that is due. A missed period (server down, game off)
// is skipped rather than paid twice later.
export function runDueSchedules(
  store: Store,
  worker: Worker,
  deploymentId: string | undefined,
  assetId: string,
  now = Date.now(),
) {
  const due = store.all(
    "SELECT * FROM allocation_schedules WHERE active=1 AND next_run_at<=? ORDER BY next_run_at",
    now,
  ) as ScheduleRow[];
  for (const s of due) {
    store.transaction(() => {
      const game = store.get("SELECT * FROM games WHERE id=?", s.game_id);
      const next = nextRun(s.cadence, s.day, now);
      const period = `schedule:${s.id}:${runKey(s.next_run_at)}`;
      let error: string | null = null;
      let allocationId: string | null = s.last_allocation_id;
      if (!game) error = "게임이 삭제되었습니다.";
      else if (!game.active)
        error = "게임이 꺼져 있어 이번 회차를 건너뛰었습니다.";
      else if (!deploymentId) error = "활성 배포가 없습니다.";
      else {
        allocationId = queueAllocation(store, worker, {
          actorId: s.created_by,
          gameId: s.game_id,
          deploymentId,
          value: BigInt(s.amount),
          ref: `${period}:weekly:base`,
          body: {
            gameId: s.game_id,
            assetId,
            amount: display(s.amount),
            period,
            scheduleId: s.id,
          },
        }).allocationId;
      }
      store.run(
        "UPDATE allocation_schedules SET next_run_at=?,last_run_at=?,last_allocation_id=?,last_error=?,active=? WHERE id=?",
        next,
        now,
        allocationId,
        error,
        game ? 1 : 0,
        s.id,
      );
    });
  }
  return due.length;
}
