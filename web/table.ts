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
  // Pre-escaped HTML; buttons are handled by delegated listeners.
  actions?: (row: T) => string;
  empty: string;
  searchPlaceholder?: string;
}
interface TableState {
  query: string;
  filter: number;
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
    state = { query: "", filter: 0, open: new Set(), kept: new Map() };
    states.set(id, state);
  }
  return state;
}

export function openTableRow(container: HTMLElement, key: string) {
  stateOf(container.id).open.add(key);
  draw(container);
}

export function renderTable<T>(container: HTMLElement, spec: TableSpec<T>) {
  specs.set(container.id, spec);
  if (!container.dataset.table) {
    container.dataset.table = "1";
    container.innerHTML = `<div class="table-toolbar"><input type="search" class="table-search" placeholder="${attr(spec.searchPlaceholder ?? "검색")}" aria-label="검색"><div class="table-filters"></div></div><div class="table-wrap"><table class="data-table"><thead></thead><tbody></tbody></table></div>`;
    const state = stateOf(container.id);
    container
      .querySelector<HTMLInputElement>(".table-search")!
      .addEventListener("input", (e) => {
        state.query = (e.target as HTMLInputElement).value;
        draw(container);
      });
    container.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const filter = target.closest<HTMLElement>("[data-table-filter]");
      if (filter) {
        state.filter = Number(filter.dataset.tableFilter);
        draw(container);
        return;
      }
      // Clicking a row (not one of its controls) toggles its details.
      if (target.closest("button, a, input, select, textarea, label")) return;
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
  // Keep text typed into detail rows (e.g. a rejection reason) across redraws.
  container
    .querySelectorAll<HTMLInputElement>("[data-keep]")
    .forEach((input) => state.kept.set(input.dataset.keep!, input.value));
  const filters = spec.filters ?? [];
  if (state.filter >= filters.length) state.filter = 0;
  container.querySelector(".table-filters")!.innerHTML = filters
    .map(
      (f, i) =>
        `<button type="button" class="filter-chip${i === state.filter ? " selected" : ""}" data-table-filter="${i}">${attr(f.label)}<span>${spec.rows.filter(f.match).length}</span></button>`,
    )
    .join("");
  const query = state.query.trim().toLowerCase();
  const rows = spec.rows.filter(
    (row) =>
      (!filters.length || filters[state.filter].match(row)) &&
      (!query || spec.searchText(row).toLowerCase().includes(query)),
  );
  const span = spec.columns.length + (spec.actions ? 1 : 0);
  container.querySelector("thead")!.innerHTML =
    `<tr>${spec.columns.map((c) => `<th class="${c.className ?? ""}">${attr(c.label)}</th>`).join("")}${spec.actions ? "<th></th>" : ""}</tr>`;
  container.querySelector("tbody")!.innerHTML = rows.length
    ? rows
        .map((row) => {
          const key = spec.key(row);
          const open = state.open.has(key);
          return `<tr data-row-key="${attr(key)}" class="${spec.detail ? "expandable" : ""}${open ? " open" : ""}">${spec.columns.map((c) => `<td class="${c.className ?? ""}">${c.cell(row)}</td>`).join("")}${spec.actions ? `<td class="row-actions">${spec.actions(row)}</td>` : ""}</tr>${open && spec.detail ? `<tr class="detail-row"><td colspan="${span}">${spec.detail(row)}</td></tr>` : ""}`;
        })
        .join("")
    : `<tr><td class="table-empty" colspan="${span}">${attr(query || state.filter ? "조건에 맞는 항목이 없습니다." : spec.empty)}</td></tr>`;
  container
    .querySelectorAll<HTMLInputElement>("[data-keep]")
    .forEach((input) => {
      const value = state.kept.get(input.dataset.keep!);
      if (value !== undefined) input.value = value;
    });
}
