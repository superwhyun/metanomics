// Admin budget allocation: pick a game from a searchable list, set an amount
// with presets or a slider, and send it once or on a weekly/monthly schedule.
import { renderTable } from "./table.js";

type Mode = "once" | "weekly" | "monthly";
interface AllocationDeps {
  api: (path: string, body?: any, method?: string) => Promise<any>;
  toast: (message: string, error?: boolean) => void;
  refresh: () => Promise<void>;
  assetId: () => string;
}
interface PickerGame {
  id: string;
  name: string;
  active: number;
  budget: string | null;
}

const PRESETS = [10, 50, 100, 500, 1000];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
// Monday first, as people read a week.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MONTHLY_LAST_DAY = 28;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const DAY_MS = 24 * 3600 * 1000;

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const number = (value: number) =>
  value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const state = {
  games: [] as PickerGame[],
  schedules: [] as any[],
  reserve: 0,
  gameId: "",
  query: "",
  mode: "once" as Mode,
  weekday: 1,
  monthday: 1,
  pending: null as null | { path: string; body: any; mode: Mode },
};

// Mirrors the server's first run: local midnight, today included.
function firstRun(mode: Mode, day: number, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (mode === "weekly") d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7));
  else if (mode === "monthly") {
    if (d.getDate() > day) d.setMonth(d.getMonth() + 1, 1);
    d.setDate(day);
  }
  return d;
}
const dateLabel = (ms: number | Date) => {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / DAY_MS);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAYS[d.getDay()]})`;
  return diff === 0 ? `오늘 · ${base}` : diff === 1 ? `내일 · ${base}` : base;
};
const cadenceLabel = (cadence: string, day: number) =>
  cadence === "weekly" ? `매주 ${WEEKDAYS[day]}요일` : `매월 ${day}일`;

const amountText = () =>
  el<HTMLInputElement>("alloc-amount").value.replace(/[,\s]/g, "");
const amountValue = () => {
  const text = amountText();
  return AMOUNT_PATTERN.test(text) ? Number(text) : NaN;
};

function setAmount(value: number) {
  const clean = Math.max(0, Math.round(value * 1e6) / 1e6);
  el<HTMLInputElement>("alloc-amount").value = clean ? String(clean) : "";
  syncAmount();
}

// The slider spans the reserve in round steps so dragging lands on whole numbers.
function sliderStep(max: number) {
  const raw = max / 100;
  if (raw <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
}

function syncAmount() {
  const value = amountValue();
  const slider = el<HTMLInputElement>("alloc-slider");
  const max = Math.max(Math.floor(state.reserve), 0);
  slider.max = String(max);
  slider.step = String(sliderStep(max));
  slider.disabled = max === 0;
  if (Number.isFinite(value)) slider.value = String(Math.min(value, max));
  const fill = max ? Math.min((Number(slider.value) / max) * 100, 100) : 0;
  slider.style.setProperty("--fill", `${fill}%`);
  const rest = state.reserve - (Number.isFinite(value) ? value : 0);
  const remaining = el("alloc-remaining");
  remaining.classList.toggle("warn", rest < 0);
  remaining.textContent = !Number.isFinite(value)
    ? "숫자로 입력하세요. 소수점은 6자리까지 됩니다."
    : rest < 0
      ? `보유분보다 ${number(-rest)} CGC 많습니다. 먼저 CGC를 발행하세요.`
      : `배분 후 남는 보유분 ${number(rest)} CGC`;
  renderSummary();
}

function renderGames() {
  const list = el("alloc-game-list");
  const query = state.query.trim().toLowerCase();
  const active = state.games.filter((g) => g.active);
  if (!active.some((g) => g.id === state.gameId))
    state.gameId = active[0]?.id ?? "";
  const shown = active.filter(
    (g) => !query || `${g.name} ${g.id}`.toLowerCase().includes(query),
  );
  const repeats = (gameId: string) =>
    state.schedules.filter((s) => s.gameId === gameId && s.active).length;
  el("alloc-game-count").textContent = `${active.length}개`;
  list.innerHTML = shown.length
    ? shown
        .map((g) => {
          const selected = g.id === state.gameId;
          const repeat = repeats(g.id);
          return `<button type="button" role="radio" aria-checked="${selected}" class="game-option${selected ? " selected" : ""}" data-pick-game="${esc(g.id)}"><span class="game-avatar" aria-hidden="true">${esc(g.name.trim().charAt(0).toUpperCase() || "?")}</span><span class="game-option-text"><strong>${esc(g.name)}</strong><small>${esc(g.id)}</small></span><span class="game-option-meta">${repeat ? `<span class="repeat-badge">반복 ${repeat}</span>` : ""}<span>${g.budget === null ? "—" : `${number(Number(g.budget))} CGC`}</span></span></button>`;
        })
        .join("")
    : `<p class="muted picker-empty">${active.length ? "검색 결과가 없습니다." : "켜진 게임이 없습니다."}</p>`;
}

function renderMode() {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-alloc-mode]",
  )) {
    const on = button.dataset.allocMode === state.mode;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-checked", String(on));
  }
  el("alloc-weekday").hidden = state.mode !== "weekly";
  el("alloc-monthday").hidden = state.mode !== "monthly";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-weekday]",
  ))
    button.classList.toggle(
      "selected",
      Number(button.dataset.weekday) === state.weekday,
    );
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-monthday]",
  ))
    button.classList.toggle(
      "selected",
      Number(button.dataset.monthday) === state.monthday,
    );
  el("alloc-submit").textContent =
    state.mode === "once" ? "지금 배분하기" : "반복 배분 등록";
  renderSummary();
}

function renderSummary() {
  const game = state.games.find((g) => g.id === state.gameId);
  const value = amountValue();
  const summary = el("alloc-summary");
  if (!game || !Number.isFinite(value) || value <= 0) {
    summary.innerHTML = `<span class="muted">게임과 금액을 고르면 여기에 요약이 나옵니다.</span>`;
    return;
  }
  const amount = `<strong>${number(value)} CGC</strong>`;
  const name = `<strong>${esc(game.name)}</strong>`;
  if (state.mode === "once") {
    summary.innerHTML = `${name}에 ${amount}를 지금 한 번 배분합니다.`;
    return;
  }
  const day = state.mode === "weekly" ? state.weekday : state.monthday;
  summary.innerHTML = `${name}에 <strong>${cadenceLabel(state.mode, day)}</strong> ${amount}씩 자동 배분합니다.<br><small>첫 배분 ${dateLabel(firstRun(state.mode, day))} · 서버 시간 0시</small>`;
}

function renderSchedules() {
  renderTable<any>(el("allocation-schedules"), {
    rows: state.schedules,
    key: (s) => s.scheduleId,
    pageSize: 10,
    searchPlaceholder: "게임 검색",
    searchText: (s) => `${s.gameName ?? ""} ${s.gameId}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "사용 중", match: (s) => s.active },
      { label: "일시 중지", match: (s) => !s.active },
    ],
    columns: [
      {
        label: "게임",
        cell: (s) =>
          `<strong>${esc(s.gameName ?? s.gameId)}</strong><small class="cell-sub">${esc(s.gameId)}</small>`,
      },
      {
        label: "주기",
        cell: (s) => esc(cadenceLabel(s.cadence, s.day)),
        className: "nowrap",
      },
      {
        label: "금액",
        cell: (s) => `${esc(number(Number(s.amount)))} CGC`,
        className: "nowrap num",
      },
      {
        label: "다음 배분",
        cell: (s) =>
          s.active
            ? esc(dateLabel(s.nextRunAt))
            : '<span class="muted">—</span>',
        className: "nowrap",
      },
      {
        label: "최근 결과",
        cell: (s) =>
          s.lastError
            ? `<span class="warn-text">${esc(s.lastError)}</span>`
            : s.lastRunAt
              ? `${esc(dateLabel(s.lastRunAt))} 배분`
              : '<span class="muted">아직 없음</span>',
      },
      {
        label: "상태",
        cell: (s) =>
          `<span class="pill ${s.active ? "" : "pending"}">${s.active ? "사용 중" : "일시 중지"}</span>`,
      },
    ],
    actions: (s) =>
      `<button type="button" class="small" data-schedule-toggle="${esc(s.scheduleId)}" data-active="${s.active ? "0" : "1"}">${s.active ? "일시 중지" : "재개"}</button><button type="button" class="small quiet" data-schedule-delete="${esc(s.scheduleId)}">삭제</button>`,
    empty: "반복 배분이 없습니다. 위에서 매주·매월을 골라 등록하세요.",
  });
}

export function renderAllocation(overview: any, schedules: any[]) {
  state.games = overview.games;
  state.schedules = schedules;
  state.reserve = Number(overview.accounting.reserve);
  el("alloc-reserve").textContent = number(state.reserve);
  renderGames();
  syncAmount();
  renderSchedules();
}

function openConfirm() {
  const game = state.games.find((g) => g.id === state.gameId);
  const text = amountText();
  if (!game) throw new Error("배분할 게임을 고르세요.");
  if (!AMOUNT_PATTERN.test(text) || Number(text) <= 0)
    throw new Error("배분할 금액을 확인하세요.");
  const day = state.mode === "weekly" ? state.weekday : state.monthday;
  const body = { gameId: game.id, assetId: "", amount: text };
  state.pending =
    state.mode === "once"
      ? { path: "/allocations", body, mode: "once" }
      : {
          path: "/allocation-schedules",
          body: { ...body, cadence: state.mode, day },
          mode: state.mode,
        };
  const rows: [string, string][] = [
    ["게임", game.name],
    ["금액", `${number(Number(text))} CGC`],
    [
      "주기",
      state.mode === "once" ? "한 번 (지금)" : cadenceLabel(state.mode, day),
    ],
  ];
  if (state.mode !== "once")
    rows.push(["첫 배분", dateLabel(firstRun(state.mode, day))]);
  el("allocation-details").innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="activity-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`,
    )
    .join("");
  el("confirm-allocation").textContent =
    state.mode === "once" ? "배분 실행" : "반복 배분 등록";
  el<HTMLDialogElement>("allocation-dialog").showModal();
}

export function initAllocation(deps: AllocationDeps) {
  el("alloc-presets").innerHTML =
    PRESETS.map(
      (p) =>
        `<button type="button" class="preset-chip" data-preset="${p}">+${number(p)}</button>`,
    ).join("") +
    `<button type="button" class="preset-chip quiet" data-preset-max>최대</button><button type="button" class="preset-chip quiet" data-preset-clear>지우기</button>`;
  el("alloc-weekday").innerHTML = WEEK_ORDER.map(
    (d) =>
      `<button type="button" class="day-chip" data-weekday="${d}">${WEEKDAYS[d]}</button>`,
  ).join("");
  el("alloc-monthday").innerHTML = Array.from(
    { length: MONTHLY_LAST_DAY },
    (_, i) =>
      `<button type="button" class="day-chip" data-monthday="${i + 1}">${i + 1}</button>`,
  ).join("");
  state.weekday = new Date().getDay();
  state.monthday = Math.min(new Date().getDate(), MONTHLY_LAST_DAY);

  el("alloc-game-search").addEventListener("input", (e) => {
    state.query = (e.target as HTMLInputElement).value;
    renderGames();
  });
  el("alloc-game-list").addEventListener("click", (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-pick-game]",
    );
    if (!pick) return;
    state.gameId = pick.dataset.pickGame!;
    renderGames();
    renderSummary();
  });
  el("alloc-amount").addEventListener("input", syncAmount);
  el("alloc-slider").addEventListener("input", (e) =>
    setAmount(Number((e.target as HTMLInputElement).value)),
  );
  el("alloc-presets").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!chip) return;
    if (chip.dataset.presetClear !== undefined) return setAmount(0);
    if (chip.dataset.presetMax !== undefined)
      return setAmount(Math.floor(state.reserve));
    const current = amountValue();
    setAmount(
      (Number.isFinite(current) ? current : 0) + Number(chip.dataset.preset),
    );
  });
  el("alloc-mode").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-alloc-mode]",
    );
    if (!button) return;
    state.mode = button.dataset.allocMode as Mode;
    renderMode();
  });
  el("alloc-weekday").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-weekday]",
    );
    if (!button) return;
    state.weekday = Number(button.dataset.weekday);
    renderMode();
  });
  el("alloc-monthday").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-monthday]",
    );
    if (!button) return;
    state.monthday = Number(button.dataset.monthday);
    renderMode();
  });
  el("allocation-form").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      openConfirm();
    } catch (error: any) {
      deps.toast(error.message, true);
    }
  });
  el("cancel-allocation").addEventListener("click", () =>
    el<HTMLDialogElement>("allocation-dialog").close(),
  );
  el("confirm-allocation").addEventListener("click", async (e) => {
    // Every allocation is new, so a double click must not send two.
    const button = e.currentTarget as HTMLButtonElement;
    const pending = state.pending;
    if (button.disabled || !pending) return;
    button.disabled = true;
    try {
      await deps.api(pending.path, {
        ...pending.body,
        assetId: deps.assetId(),
      });
      el<HTMLDialogElement>("allocation-dialog").close();
      deps.toast(
        pending.mode === "once"
          ? "배분을 접수했습니다. 블록에 실리면 몇 초 안에 예산에 반영됩니다."
          : "반복 배분을 등록했습니다.",
      );
      await deps.refresh();
      if (pending.mode === "once")
        setTimeout(() => void deps.refresh().catch(() => {}), 6000);
    } catch (error: any) {
      deps.toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  el("allocation-schedules").addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const toggle = target.closest<HTMLButtonElement>("[data-schedule-toggle]");
    const remove = target.closest<HTMLButtonElement>("[data-schedule-delete]");
    try {
      if (toggle) {
        await deps.api(
          `/allocation-schedules/${toggle.dataset.scheduleToggle}`,
          { active: toggle.dataset.active === "1" },
          "PATCH",
        );
        await deps.refresh();
      } else if (remove) {
        // Deleting cannot be undone, so the first click only asks again.
        if (!remove.dataset.armed) {
          remove.dataset.armed = "1";
          remove.textContent = "정말 삭제";
          remove.classList.add("danger");
          return;
        }
        await deps.api(
          `/allocation-schedules/${remove.dataset.scheduleDelete}`,
          undefined,
          "DELETE",
        );
        deps.toast("반복 배분을 삭제했습니다. 이미 보낸 배분은 그대로입니다.");
        await deps.refresh();
      }
    } catch (error: any) {
      deps.toast(error.message, true);
    }
  });
  renderMode();
}
