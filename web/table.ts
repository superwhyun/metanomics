// Searchable, filterable tables whose search text, filter and expanded rows
// survive the periodic re-render of the admin screens.
export interface TableColumn<T> {
  label: string;
  cell: (row: T) => string;
  className?: string;
}
export interface TableFilter<T> {
  label: string;
  match: (row: T) => boolean;
}
export interface TableSpec<T> {
  rows: T[];
  key: (row: T) => string;
  columns: TableColumn<T>[];
  searchText: (row: T) => string;
  filters?: TableFilter<T>[];
  // Pre-escaped HTML for the expandable detail row.
  detail?: (row: T) => string;
  detailLabel?: (row: T) => string;
  // Pre-escaped HTML; buttons are handled by delegated listeners.
  actions?: (row: T) => string;
  empty: string;
  searchPlaceholder?: string;
  // Rows per page; without it every matching row is shown.
  pageSize?: number;
}
interface TableState {
  query: string;
  filter: number;
  page: number;
  open: Set<string>;
  kept: Map<string, string>;
}

const attr = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const states = new Map<string, TableState>();
const specs = new Map<string, TableSpec<any>>();

function stateOf(id: string) {
  let state = states.get(id);
  if (!state) {
    state = {
      query: "",
      filter: 0,
      page: 0,
      open: new Set(),
      kept: new Map(),
    };
    states.set(id, state);
  }
  return state;
}

export function openTableRow(container: HTMLElement, key: string) {
  stateOf(container.id).open.add(key);
  draw(container);
}

export function setTableView(
  container: HTMLElement,
  filter: string,
  query = "",
) {
  const state = stateOf(container.id);
  const search = container.querySelector<HTMLInputElement>(".table-search");
  if (!search) return;
  state.filter = Math.max(
    0,
    specs
      .get(container.id)
      ?.filters?.findIndex((item) => item.label === filter) ?? 0,
  );
  state.query = search.value = query;
  state.page = 0;
  draw(container);
}

export function renderTable<T>(container: HTMLElement, spec: TableSpec<T>) {
  specs.set(container.id, spec);
  if (!container.dataset.table) {
    container.dataset.table = "1";
    const searchLabel = attr(spec.searchPlaceholder ?? "검색");
    container.innerHTML = `<div class="table-toolbar"><input type="search" class="table-search" placeholder="${searchLabel}" aria-label="${searchLabel}"><div class="table-filters"></div></div><div class="table-wrap"><table class="data-table" role="table"><thead role="rowgroup"></thead><tbody role="rowgroup"></tbody></table></div><nav class="table-pager" aria-label="페이지"></nav>`;
    const state = stateOf(container.id);
    container
      .querySelector<HTMLInputElement>(".table-search")!
      .addEventListener("input", (e) => {
        state.query = (e.target as HTMLInputElement).value;
        state.page = 0;
        draw(container);
      });
    container.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const filter = target.closest<HTMLElement>("[data-table-filter]");
      if (filter) {
        state.filter = Number(filter.dataset.tableFilter);
        state.page = 0;
        draw(container);
        return;
      }
      const page = target.closest<HTMLButtonElement>("[data-table-page]");
      if (page) {
        state.page = Number(page.dataset.tablePage);
        draw(container);
        return;
      }
      // A real button supports keyboard use, and the row remains a pointer shortcut.
      const details = target.closest("[data-table-detail]");
      if (
        !details &&
        target.closest("button, a, input, select, textarea, label")
      )
        return;
      const row = target.closest<HTMLElement>("tr[data-row-key]");
      if (!row || !specs.get(container.id)?.detail) return;
      const key = row.dataset.rowKey!;
      if (state.open.has(key)) state.open.delete(key);
      else state.open.add(key);
      draw(container);
    });
  }
  draw(container);
}

function draw(container: HTMLElement) {
  const spec = specs.get(container.id)!;
  const state = stateOf(container.id);
  const active = document.activeElement as HTMLElement | null;
  const focusFilter = container.contains(active)
    ? active?.dataset.tableFilter
    : undefined;
  const focusDetail =
    container.contains(active) && active?.hasAttribute("data-table-detail")
      ? active.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey
      : undefined;
  // Keep text typed into detail rows (e.g. a rejection reason) across redraws.
  container
    .querySelectorAll<HTMLInputElement>("[data-keep]")
    .forEach((input) => state.kept.set(input.dataset.keep!, input.value));
  const filters = spec.filters ?? [];
  if (state.filter >= filters.length) state.filter = 0;
  container.querySelector(".table-filters")!.innerHTML = filters
    .map(
      (f, i) =>
        `<button type="button" class="filter-chip${i === state.filter ? " selected" : ""}" data-table-filter="${i}" aria-pressed="${i === state.filter}">${attr(f.label)}<span>${spec.rows.filter(f.match).length}</span></button>`,
    )
    .join("");
  const query = state.query.trim().toLowerCase();
  const rows = spec.rows.filter(
    (row) =>
      (!filters.length || filters[state.filter].match(row)) &&
      (!query || spec.searchText(row).toLowerCase().includes(query)),
  );
  const size = spec.pageSize ?? rows.length;
  const pages = Math.max(1, Math.ceil(rows.length / Math.max(size, 1)));
  state.page = Math.min(state.page, pages - 1);
  const visible = spec.pageSize
    ? rows.slice(state.page * size, (state.page + 1) * size)
    : rows;
  const pager = container.querySelector<HTMLElement>(".table-pager")!;
  pager.hidden = pages <= 1;
  pager.innerHTML =
    pages <= 1
      ? ""
      : `<button type="button" class="small" data-table-page="${state.page - 1}"${state.page === 0 ? " disabled" : ""}>‹ 이전</button><span>${state.page + 1} / ${pages} <small>· ${rows.length}건</small></span><button type="button" class="small" data-table-page="${state.page + 1}"${state.page === pages - 1 ? " disabled" : ""}>다음 ›</button>`;
  const hasActions = !!(spec.actions || spec.detail);
  const span = spec.columns.length + Number(hasActions);
  container.querySelector("thead")!.innerHTML =
    `<tr role="row">${spec.columns.map((c) => `<th scope="col" role="columnheader" class="${c.className ?? ""}">${attr(c.label)}</th>`).join("")}${hasActions ? '<th scope="col" role="columnheader">작업</th>' : ""}</tr>`;
  container.querySelector("tbody")!.innerHTML = visible.length
    ? visible
        .map((row) => {
          const key = spec.key(row);
          const open = state.open.has(key);
          const details = spec.detail
            ? `<button type="button" class="small quiet" data-table-detail aria-expanded="${open}">${open ? "상세 닫기" : attr(spec.detailLabel?.(row) ?? "상세 보기")}</button>`
            : "";
          const actions = `${details}${spec.actions?.(row) ?? ""}`;
          return `<tr role="row" data-row-key="${attr(key)}" class="${spec.detail ? "expandable" : ""}${open ? " open" : ""}">${spec.columns.map((c) => `<td role="cell" class="${c.className ?? ""}"><span class="mobile-cell-label" aria-hidden="true">${attr(c.label)}</span><div>${c.cell(row)}</div></td>`).join("")}${hasActions ? `<td role="cell" class="row-actions">${actions}</td>` : ""}</tr>${open && spec.detail ? `<tr role="row" class="detail-row"><td role="cell" colspan="${span}">${spec.detail(row)}</td></tr>` : ""}`;
        })
        .join("")
    : `<tr><td class="table-empty" colspan="${span}">${attr(query || state.filter ? "조건에 맞는 항목이 없습니다." : spec.empty)}</td></tr>`;
  container
    .querySelectorAll<HTMLInputElement>("[data-keep]")
    .forEach((input) => {
      const value = state.kept.get(input.dataset.keep!);
      if (value !== undefined) input.value = value;
    });
  if (focusFilter !== undefined)
    container
      .querySelector<HTMLElement>(`[data-table-filter="${focusFilter}"]`)
      ?.focus({ preventScroll: true });
  if (focusDetail !== undefined)
    container
      .querySelector<HTMLElement>(
        `[data-row-key="${CSS.escape(focusDetail)}"] [data-table-detail]`,
      )
      ?.focus({ preventScroll: true });
}
