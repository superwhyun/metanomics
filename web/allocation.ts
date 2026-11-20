import { formatUnits, parseUnits } from "viem";
import { randomUUID } from "./random.js";
import { renderTable, setTableView } from "./table.js";

type BudgetView = "once" | "schedules" | "schedule-new" | "issuance";
type Cadence = "weekly" | "monthly";
interface AllocationDeps {
  api: (
    path: string,
    body?: any,
    method?: string,
    retryKey?: string,
  ) => Promise<any>;
  confirm: (
    title: string,
    details: string,
    button: string,
    submit: () => Promise<void>,
  ) => void;
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
interface Schedule {
  scheduleId: string;
  gameId: string;
  gameName: string | null;
  amount: string;
  cadence: Cadence;
  day: number;
  active: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastError: string | null;
}

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const field = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
export function cgcUnits(value: string) {
  if (value.length > 85 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    return undefined;
  const units = parseUnits(value, 6);
  return units < 2n ** 256n ? units : undefined;
}
export function cgcLabel(value: bigint) {
  const [integer, fraction] = formatUnits(value, 6).split(".");
  return `${BigInt(integer).toLocaleString("ko-KR")}${fraction ? `.${fraction}` : ""}`;
}
const cgcAmount = (value: string) => {
  const units = cgcUnits(value);
  return units === undefined ? "—" : cgcLabel(units);
};
const weekdays = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
];
const cadenceLabel = (cadence: Cadence, day: number) =>
  cadence === "weekly" ? `매주 ${weekdays[day]}` : `매월 ${day}일`;
const dateLabel = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const rows = (entries: [string, string][]) =>
  entries
    .map(
      ([label, value]) =>
        `<div class="activity-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`,
    )
    .join("");

let view: BudgetView = "once";
let reserve: bigint | undefined;
let games: PickerGame[] = [];
let schedules: Schedule[] = [];
let allocationNotice = "";

export function selectBudgetView(next: BudgetView, focus = true) {
  if (view !== next) allocationNotice = "";
  view = next;
  const repeat = view === "schedule-new";
  const allocation = view === "once" || repeat;
  el("allocation-panel").hidden = !allocation;
  el("schedule-panel").hidden = view !== "schedules";
  el("issuance-panel").hidden = view !== "issuance";
  for (const button of el("budget-menu").querySelectorAll<HTMLButtonElement>(
    "[data-budget-view]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.budgetView === (repeat ? "schedules" : view)),
    );
  el("allocation-title").textContent = repeat
    ? "반복 배분 일정 추가"
    : "게임에 예산 보내기";
  el("alloc-amount-label").textContent = repeat
    ? "회당 보낼 금액 (CGC)"
    : "보낼 금액 (CGC)";
  el("alloc-back").hidden = el("alloc-repeat").hidden = !repeat;
  el("alloc-submit").textContent = repeat ? "일정 내용 확인" : "배분 내용 확인";
  renderAllocationFeedback();
  if (focus) {
    const panel = el(
      allocation
        ? "allocation-panel"
        : view === "schedules"
          ? "schedule-panel"
          : "issuance-panel",
    );
    const heading = panel.querySelector("h2")!;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function renderAllocationFeedback() {
  const game = games.find(
    (entry) => entry.id === select("alloc-game-select").value,
  );
  const budget = el("alloc-game-budget");
  budget.hidden = !game;
  budget.textContent =
    game?.budget == null
      ? "선택한 게임의 현재 예산을 확인할 수 없습니다."
      : `현재 게임 예산 ${cgcAmount(game.budget)} CGC`;
  const text = field("alloc-amount").value.trim();
  const amount = cgcUnits(text);
  const repeat = view === "schedule-new";
  let message = allocationNotice;
  let error = false;
  if (reserve === undefined) message = "배분 가능 보유분을 확인하고 있습니다…";
  else if (!games.length)
    message = "배분할 수 있는 게임이 없습니다. [게임] 메뉴에서 게임을 켜세요.";
  else if (text && !amount) {
    error = true;
    message =
      "0보다 큰 수량을 입력하세요. 소수점 아래는 6자리까지 입력할 수 있어요.";
  } else if (amount && amount > reserve) {
    error = !repeat;
    message = repeat
      ? "현재 보유분이 회당 금액보다 적습니다. 실행 시 보유분이 충분해야 배분됩니다."
      : "배분 가능 보유분을 넘었어요. 보낼 금액을 줄이세요.";
  } else if (amount && !repeat)
    message = `배분 후 남는 보유분 ${cgcLabel(reserve - amount)} CGC`;
  const feedback = el("alloc-feedback");
  feedback.classList.toggle("feedback-error", error);
  if (feedback.textContent !== message) feedback.textContent = message;
  el<HTMLButtonElement>("alloc-submit").disabled =
    !games.length || reserve === undefined || error;
}

function renderGames() {
  const picker = select("alloc-game-select");
  const selected = picker.value;
  const search = field("alloc-game-search");
  el("alloc-game-filter").hidden = games.length <= 8;
  if (el("alloc-game-filter").hidden) search.value = "";
  const query = search.value.trim().toLowerCase();
  const visible = games.filter(
    (game) =>
      game.id === selected ||
      `${game.name} ${game.id}`.toLowerCase().includes(query),
  );
  const options = [
    new Option(
      visible.length
        ? "게임 선택"
        : query
          ? "검색 결과 없음"
          : "배분할 게임 없음",
      "",
    ),
    ...visible.map((game) => new Option(`${game.name} · ${game.id}`, game.id)),
  ];
  if (
    options.length !== picker.options.length ||
    options.some(
      (option, i) =>
        option.value !== picker.options[i].value ||
        option.text !== picker.options[i].text,
    )
  ) {
    picker.replaceChildren(...options);
    picker.value = visible.some((game) => game.id === selected) ? selected : "";
  }
  renderAllocationFeedback();
}

function renderDays() {
  const weekly = select("alloc-cadence").value === "weekly";
  el("alloc-day-label").textContent = weekly ? "요일" : "날짜";
  select("alloc-day").replaceChildren(
    ...(weekly
      ? [1, 2, 3, 4, 5, 6, 0].map(
          (day) => new Option(weekdays[day], String(day)),
        )
      : Array.from(
          { length: 28 },
          (_, i) => new Option(`${i + 1}일`, String(i + 1)),
        )),
  );
}

export function renderAllocation(
  overview: { games: PickerGame[]; accounting: { reserve: string } },
  entries: Schedule[],
) {
  games = overview.games.filter((game) => game.active);
  schedules = entries;
  reserve = cgcUnits(overview.accounting.reserve);
  el("alloc-reserve").textContent =
    reserve === undefined ? "—" : cgcLabel(reserve);
  renderGames();
  el("allocation-schedules").hidden = !schedules.length;
  el("empty-schedules").hidden = !!schedules.length;
  renderTable<Schedule>(el("allocation-schedules"), {
    rows: schedules,
    key: (s) => s.scheduleId,
    pageSize: 10,
    searchPlaceholder: "반복 배분 게임 검색",
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
          `<strong>${esc(s.gameName ?? s.gameId)}</strong><small>${esc(s.gameId)}</small>`,
      },
      {
        label: "배분",
        cell: (s) =>
          `<strong>${cgcAmount(s.amount)} CGC</strong><small>${cadenceLabel(s.cadence, s.day)}</small>`,
      },
      {
        label: "다음 배분",
        cell: (s) =>
          s.active
            ? esc(dateLabel(s.nextRunAt))
            : `<span class="pill pending">일시 중지</span>`,
      },
    ],
    detail: (s) =>
      `<p class="muted">${s.lastError ? `최근 실행 오류 · ${esc(s.lastError)}` : s.lastRunAt ? `최근 실행 · ${esc(dateLabel(s.lastRunAt))}` : "아직 실행 기록이 없습니다."}</p>`,
    actions: (s) =>
      `<button type="button" class="small" data-schedule-toggle="${esc(s.scheduleId)}">${s.active ? "일시 중지" : "재개"}</button><button type="button" class="small quiet" data-schedule-delete="${esc(s.scheduleId)}">삭제</button>`,
    empty: "반복 배분 일정이 없습니다.",
  });
}

export function initAllocation(deps: AllocationDeps) {
  const refresh = () =>
    deps
      .refresh()
      .catch(() =>
        deps.toast("요청은 접수됐습니다. 새로고침해 최신 상태를 확인하세요."),
      );
  el("budget-menu").addEventListener("click", (event) => {
    const viewButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-budget-view]",
    );
    if (viewButton)
      selectBudgetView(viewButton.dataset.budgetView as BudgetView);
  });
  el("add-allocation-schedule").addEventListener("click", () =>
    selectBudgetView("schedule-new"),
  );
  el("alloc-back").addEventListener("click", () =>
    selectBudgetView("schedules"),
  );
  field("alloc-game-search").addEventListener("input", renderGames);
  select("alloc-game-select").addEventListener(
    "change",
    renderAllocationFeedback,
  );
  field("alloc-amount").addEventListener("input", () => {
    allocationNotice = "";
    renderAllocationFeedback();
  });
  select("alloc-cadence").addEventListener("change", renderDays);
  renderDays();
  selectBudgetView("once", false);

  el("allocation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const repeat = view === "schedule-new";
    const game = games.find(
      (entry) => entry.id === select("alloc-game-select").value,
    );
    const amount = field("alloc-amount").value.trim();
    const value = cgcUnits(amount);
    if (
      !game ||
      !value ||
      reserve === undefined ||
      (!repeat && value > reserve)
    )
      return;
    const cadence = select("alloc-cadence").value as Cadence;
    const day = Number(select("alloc-day").value);
    const key = randomUUID();
    const body = { gameId: game.id, assetId: deps.assetId(), amount };
    const details = rows([
      ["보내는 곳", "네트워크 보유분"],
      ["받는 게임", game.name],
      [repeat ? "회당 금액" : "배분 금액", `${cgcLabel(value)} CGC`],
      repeat
        ? ["실행 시각", `${cadenceLabel(cadence, day)} 서버 시간 자정`]
        : ["배분 후 남는 보유분", `${cgcLabel(reserve - value)} CGC`],
    ]);
    deps.confirm(
      repeat ? "반복 배분 일정을 확인하세요" : "배분 내용을 확인하세요",
      details,
      repeat ? "일정 등록" : "배분 실행",
      async () => {
        await (repeat
          ? deps.api(
              "/allocation-schedules",
              { ...body, cadence, day },
              "POST",
              key,
            )
          : deps.api("/allocations", body, "POST", key));
        field("alloc-amount").value = "";
        if (repeat) {
          setTableView(el("allocation-schedules"), "전체");
          selectBudgetView("schedules", false);
          requestAnimationFrame(() => selectBudgetView("schedules"));
        } else {
          allocationNotice =
            "배분을 접수했습니다. 진행 상태는 작업·장애에서 확인할 수 있어요.";
          renderAllocationFeedback();
        }
        deps.toast(
          repeat ? "반복 배분 일정을 등록했습니다." : "배분을 접수했습니다.",
        );
        void refresh();
      },
    );
  });

  const busy = new Set<string>();
  el("allocation-schedules").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-schedule-toggle], [data-schedule-delete]",
    );
    if (!button) return;
    const id = button.dataset.scheduleToggle ?? button.dataset.scheduleDelete;
    const schedule = schedules.find((entry) => entry.scheduleId === id);
    if (!schedule || busy.has(schedule.scheduleId)) return;
    const path = `/allocation-schedules/${schedule.scheduleId}`;
    if (button.dataset.scheduleDelete) {
      deps.confirm(
        "반복 배분 일정을 삭제할까요?",
        rows([
          ["게임", schedule.gameName ?? schedule.gameId],
          [
            "일정",
            `${cadenceLabel(schedule.cadence, schedule.day)} ${cgcAmount(schedule.amount)} CGC`,
          ],
          ["삭제 후", "앞으로 예정된 배분이 중단됩니다."],
        ]),
        "일정 삭제",
        async () => {
          await deps.api(path, undefined, "DELETE");
          deps.toast("반복 배분 일정을 삭제했습니다.");
          void refresh();
        },
      );
      return;
    }
    busy.add(schedule.scheduleId);
    button.disabled = true;
    void deps
      .api(path, { active: !schedule.active }, "PATCH")
      .then(() => {
        deps.toast(
          schedule.active
            ? "반복 배분을 일시 중지했습니다."
            : "반복 배분을 재개했습니다.",
        );
        return refresh();
      })
      .catch((error: Error) => deps.toast(error.message, true))
      .finally(() => {
        busy.delete(schedule.scheduleId);
        button.disabled = false;
      });
  });
}
