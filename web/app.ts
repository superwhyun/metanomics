import { renderOperatorIntegration } from "./operator-integration.js";
import { randomUUID } from "./random.js";
import { renderPlayerBalance } from "./player-balance.js";
import {
  WalletAliasCache,
  renderAccountChoices,
  renderLoginWallets,
  type NamedWallet,
} from "./wallet-aliases.js";
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, getAddress, keccak256, parseEther, toHex } from "viem";
import { openTableRow, renderTable, setTableView } from "./table.js";
import {
  cgcLabel,
  cgcUnits,
  initAllocation,
  renderAllocation,
  selectBudgetView,
} from "./allocation.js";
import {
  WalletDiscovery,
  assertWalletSession,
  connectInjectedWallet,
  walletErrorMessage,
  revokeWalletConnection,
  type WalletChoice,
  type WalletProvider,
} from "./wallet.js";

const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const show = (selector: string, visible: boolean) =>
  $(selector).classList.toggle("hidden", !visible);
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (value: string) =>
  value ? `${value.slice(0, 7)}…${value.slice(-5)}` : "—";
const format = (value: string) =>
  Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 6 });
const words: Record<string, string> = {
  CREATED: "결제 대기",
  PROCESSING: "결제 처리 중",
  PAID: "결제 확정",
  DELIVERY_CLAIMED: "아이템 지급 중",
  COMPLETED: "구매 완료",
  REFUNDED: "환불 완료",
  EXPIRED: "기한 만료",
  FINALIZED: "완료",
  FAILED: "실패",
  QUEUED: "대기",
  PREPARED: "제출 준비",
  SUBMITTED: "제출됨",
  INCLUDED: "확정 대기",
  RECONCILING: "결과 확인 중",
  ACTIVE: "공개 중",
  INACTIVE: "운영 중지",
  PENDING: "검토 대기",
  REGISTERING: "등록 확정 대기",
  APPROVED: "등록 승인",
  REJECTED: "반려",
  MINTING: "발행 중",
  APPROVING: "충전 승인 중",
  FUNDING: "보유분 입금 중",
};
const pill = (s: string, label = words[s] ?? s) =>
  `<span class="pill ${["FAILED", "REJECTED"].includes(s) ? "failed" : ["COMPLETED", "FINALIZED", "APPROVED", "ACTIVE"].includes(s) ? "" : "pending"}">${esc(label)}</span>`;
const APPLICATION_WORDS: Record<string, string> = {
  PENDING: "검토 대기",
  APPROVED: "운영자 승인",
  REJECTED: "반려",
};
const applicationPill = (s: string) => pill(s, APPLICATION_WORDS[s] ?? s);
type Role = "player" | "operator" | "admin";
const ROLE_LABELS: Record<Role, string> = {
  player: "일반 이용자",
  operator: "게임 운영자",
  admin: "네트워크 운영자",
};
// Each role sees its own tabs; elements opt into a tab with data-tab.
const ROLE_TABS: Record<Role, [string, string][]> = {
  player: [
    ["play", "게임"],
    ["activity", "내역"],
    ["account", "지갑"],
    ["apply", "운영자 신청"],
  ],
  operator: [
    ["games", "내 게임"],
    ["integration", "서버 연결"],
    ["register", "게임 등록"],
    ["recovery", "결제 복구"],
    ["account", "지갑"],
  ],
  admin: [
    ["overview", "개요"],
    ["review", "심사"],
    ["budget", "예산·발행"],
    ["games", "게임"],
    ["ops", "작업·장애"],
    ["audit", "관리 기록"],
    ["account", "지갑"],
  ],
};
let currentTab = "";
function roleTabs() {
  return ROLE_TABS[(me?.role as Role) ?? "player"] ?? ROLE_TABS.player;
}
function setWorkspaceMenu(open: boolean) {
  $("#workspace-menu").setAttribute("aria-expanded", String(open));
}
function selectTab(tab: string, keepHistory = false) {
  const tabs = roleTabs();
  currentTab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const role = (me?.role as Role) ?? "player";
  const currentLabel = tabs.find(([id]) => id === currentTab)?.[1] ?? "";
  $("#workspace-menu-label").textContent = currentLabel;
  $("#workspace-menu").setAttribute(
    "aria-label",
    `메뉴, 현재 화면 ${currentLabel}`,
  );
  setWorkspaceMenu(false);
  const heading = document.querySelector(`#${role}-view .page-heading h1`);
  if (heading) heading.textContent = currentLabel;
  document
    .querySelectorAll<HTMLElement>("#workspace [data-tab]")
    .forEach((el) =>
      el.classList.toggle(
        "tab-hidden",
        !el.dataset.tab!.split(" ").includes(currentTab),
      ),
    );
  document
    .querySelectorAll<HTMLAnchorElement>("#navigation [data-nav]")
    .forEach((b) => {
      const selected = b.dataset.nav === currentTab;
      b.classList.toggle("selected", selected);
      if (selected) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  if (location.hash !== `#${currentTab}`) {
    if (keepHistory) history.pushState(null, "", `#${currentTab}`);
    else history.replaceState(null, "", `#${currentTab}`);
  }
}
function renderNav() {
  $("#navigation").innerHTML = roleTabs()
    .map(
      ([id, label]) =>
        `<a href="#${id}" data-nav="${id}">${esc(label)}<span class="tab-count hidden" data-count-for="${id}"></span></a>`,
    )
    .join("");
  selectTab(location.hash.slice(1));
}
function setTabCount(tab: string, count: number, tone = "pending") {
  const el = document.querySelector<HTMLElement>(`[data-count-for="${tab}"]`);
  if (!el) return;
  el.textContent = String(count);
  el.className = `tab-count ${tone}${count ? "" : " hidden"}`;
}
function revealSection(section: HTMLElement, startOfPage = false) {
  if (section instanceof HTMLDetailsElement) section.open = true;
  const heading = section.querySelector<HTMLElement>("h2, summary") ?? section;
  if (heading.tagName !== "SUMMARY") heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  if (startOfPage) window.scrollTo({ top: 0 });
  else section.scrollIntoView({ block: "start" });
}
interface StepAction {
  label: string;
  goto?: string;
  click?: string;
  focus?: string;
  gameId?: string;
}
interface Step {
  title: string;
  detail: string;
  done: boolean;
  action?: StepAction;
}
function renderSteps(
  listSelector: string,
  progressSelector: string,
  steps: Step[],
) {
  const next = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  $(progressSelector).textContent = `${doneCount} / ${steps.length} 완료`;
  const guide = $(listSelector).closest("details");
  if (guide) guide.hidden = doneCount === steps.length;
  $(listSelector).innerHTML = steps
    .map((s, i) => {
      const state = s.done ? "done" : i === next ? "current" : "upcoming";
      const a = s.action;
      const button =
        state === "current" && a
          ? `<button type="button" class="primary" ${a.goto ? `data-goto="${esc(a.goto)}"` : ""} ${a.click ? `data-step-click="${esc(a.click)}"` : ""} ${a.focus ? `data-step-focus="${esc(a.focus)}"` : ""} ${a.gameId ? `data-operator-game-target="${esc(a.gameId)}"` : ""}>${esc(a.label)} →</button>`
          : "";
      return `<li class="step-item ${state}"><span class="step-dot" aria-hidden="true">${s.done ? "✓" : i + 1}</span><div class="step-body"><strong>${esc(s.title)}</strong><span>${esc(s.done ? "완료" : s.detail)}</span></div>${button}</li>`;
    })
    .join("");
}
let catalogKey = "";
let token = sessionStorage.getItem("metanomic-session") ?? "";
let me: any,
  asset: any,
  localAccount: any,
  address: `0x${string}` | undefined,
  currentPayment: any,
  latestOverview: any;
let refreshBusy = false;
let checkoutLoading = false;
let operatorRegistrations: any[] = [];
let selectedOperatorGameId = "";
let catalogGames: any[] = [];
const walletDiscovery = new WalletDiscovery(window);
const walletAliases = new WalletAliasCache();
let walletProvider: WalletProvider | undefined;
let walletChainId: number | undefined;
let approvalWallet: string | undefined;
let connectedWalletName: string | undefined;
let stopWalletEvents: (() => void) | undefined;
let authBusy = false;
let sessionEpoch = 0;
function resetSession() {
  sessionEpoch++;
  sessionStorage.removeItem("metanomic-session");
  sessionStorage.removeItem("metanomic-login-wallet");
  token = "";
  me = undefined;
  address = undefined;
  localAccount = undefined;
  currentPayment = undefined;
  walletProvider = undefined;
  walletChainId = undefined;
  approvalWallet = undefined;
  connectedWalletName = undefined;
  stopWalletEvents?.();
  stopWalletEvents = undefined;
  catalogKey = "";
  selectedOperatorGameId = "";
  delete document.body.dataset.role;
  budgetProgress.clear();
  $("#operator-integration").replaceChildren();
  renderPlayerBalance($("#player-balance"));
  show("#login-view", true);
  show("#workspace", false);
  show("#logout", false);
  $("#identity").textContent = "";
  $("#login-wallets").replaceChildren();
  show("#balance-wallet-note", false);
  $("#wallet-tools").removeAttribute("open");
  $("#account-reset-details").removeAttribute("open");
  for (const dialog of document.querySelectorAll<HTMLDialogElement>(
    "dialog[open]",
  ))
    dialog.close();
}
function toast(message: string, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  show("#toast", true);
  setTimeout(() => show("#toast", false), 6500);
}
async function api(
  path: string,
  body?: any,
  method = body === undefined ? "GET" : "POST",
  retryKey?: string,
) {
  const response = await fetch(`/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": retryKey ?? randomUUID(),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (response.status === 401 && !path.startsWith("/sessions")) resetSession();
  if (!response.ok)
    throw Object.assign(new Error(result.error?.message ?? "요청 실패"), {
      code: result.error?.code,
    });
  return result;
}
function on(
  selector: string,
  event: string,
  fn: (event: any) => Promise<void> | void,
) {
  $(selector).addEventListener(event, async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    const disable = button.tagName === "BUTTON";
    if (disable) button.disabled = true;
    try {
      await fn(e);
    } catch (error: any) {
      toast(walletErrorMessage(error), true);
    } finally {
      if (disable) button.disabled = false;
    }
  });
}
async function chooseWallet(): Promise<WalletChoice> {
  walletDiscovery.request();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const dialog = $<HTMLDialogElement>("#wallet-dialog");
  const choices = $("#wallet-choices");
  choices.replaceChildren();
  const wallets = walletDiscovery.wallets();
  show("#wallet-not-found", wallets.length === 0);
  return new Promise((resolve, reject) => {
    const closed = () => {
      dialog.removeEventListener("close", closed);
      reject(new Error("지갑 연결을 취소했습니다."));
    };
    dialog.addEventListener("close", closed);
    for (const wallet of wallets) {
      const button = document.createElement("button");
      button.type = "button";
      // Wallet metadata is supplied by extensions; render names as text only.
      button.textContent = wallet.name;
      button.addEventListener("click", () => {
        dialog.removeEventListener("close", closed);
        dialog.close();
        resolve(wallet);
      });
      choices.append(button);
    }
    dialog.showModal();
  });
}
// Shown when the extension exposes several accounts to this site.
function chooseAccount(accounts: string[]): Promise<string> {
  const dialog = $<HTMLDialogElement>("#account-dialog");
  const choices = $("#account-choices");
  choices.replaceChildren();
  return new Promise((resolve, reject) => {
    const closed = () => {
      dialog.removeEventListener("close", closed);
      reject(new Error("계정 선택을 취소했습니다."));
    };
    dialog.addEventListener("close", closed);
    renderAccountChoices(choices, accounts, walletAliases, (account) => {
      dialog.removeEventListener("close", closed);
      dialog.close();
      resolve(account);
    });
    dialog.showModal();
  });
}
// Ronin hands the site whichever account is selected inside the extension, so
// show the address before anything is signed and let the user back out.
function confirmWallet(
  account: string,
  purpose: string,
  provider?: WalletProvider,
): Promise<void> {
  const dialog = $<HTMLDialogElement>("#wallet-confirm-dialog");
  $("#wallet-confirm-purpose").textContent = purpose;
  $("#wallet-confirm-address").textContent = account;
  return new Promise((resolve, reject) => {
    const finish = (confirmed: boolean) => {
      dialog.removeEventListener("close", closed);
      $("#wallet-confirm-ok").onclick = null;
      $("#wallet-confirm-other").onclick = null;
      dialog.close();
      if (confirmed) resolve();
      else {
        // Best effort: wallets without EIP-2255 keep the site connection.
        if (provider) void revokeWalletConnection(provider);
        reject(
          new Error(
            "지갑에서 사용할 계정으로 전환하고, 지갑의 Connected dApps에서 이 사이트 연결을 해제한 뒤 다시 시도하세요.",
          ),
        );
      }
    };
    const closed = () => finish(false);
    dialog.addEventListener("close", closed);
    $("#wallet-confirm-ok").onclick = () => finish(true);
    $("#wallet-confirm-other").onclick = () => finish(false);
    dialog.showModal();
  });
}
async function connectWallet(purpose?: string) {
  const wallet = await chooseWallet();
  const deployment = asset.deployments.find(
    (d: any) => d.id === asset.activeDeploymentId,
  );
  const connected = await connectInjectedWallet(wallet.provider, deployment, {
    reselect: true,
    chooseAccount,
  });
  if (purpose) await confirmWallet(connected, purpose, wallet.provider);
  // Keep the previous connection intact if account/network approval is rejected.
  address = connected;
  localAccount = undefined;
  walletProvider = wallet.provider;
  walletChainId = deployment.chainId;
  stopWalletEvents?.();
  const accountsChanged = (accounts: unknown) => {
    const loginAddress = sessionStorage.getItem("metanomic-login-wallet");
    // The login account may be any authorized account, not only the wallet's first.
    const stillAuthorized =
      Array.isArray(accounts) &&
      accounts.some(
        (a) => String(a).toLowerCase() === loginAddress?.toLowerCase(),
      );
    if (loginAddress && !stillAuthorized) {
      const logout = api("/sessions/me", undefined, "DELETE");
      resetSession();
      void logout.catch(() => {});
      toast(
        "지갑 계정이 변경되었습니다. 사용할 지갑으로 다시 로그인하세요.",
        true,
      );
    }
  };
  wallet.provider.on?.("accountsChanged", accountsChanged);
  stopWalletEvents = () =>
    wallet.provider.removeListener?.("accountsChanged", accountsChanged);
  connectedWalletName = wallet.name;
  renderSigningWallet();
}
async function signingProvider() {
  if (!walletProvider || !address) await connectWallet();
  await assertWalletSession(walletProvider!, address!, walletChainId!);
  return walletProvider!;
}
async function signTyped(request: any) {
  if (localAccount) return localAccount.signTypedData(request);
  const provider = await signingProvider();
  if (Number(request.domain.chainId) !== walletChainId)
    throw new Error(
      "승인 대상과 지갑 네트워크가 다릅니다. 지갑을 다시 연결하세요.",
    );
  const EIP712Domain = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [
      address,
      JSON.stringify({ ...request, types: { EIP712Domain, ...request.types } }),
    ],
  });
}
function renderCurrentLoginWallet(
  loginAddress: string | null,
  alias?: string | null,
) {
  $("#current-login-name").textContent = loginAddress
    ? (alias ?? "")
    : "이 세션에서 사용 중인 로그인 지갑이 없습니다.";
  const displayedAddress = $("#current-login-address");
  displayedAddress.textContent = loginAddress ? short(loginAddress) : "";
  displayedAddress.title = loginAddress ?? "";
}

function renderSigningWallet() {
  $("#approval-wallet").textContent = approvalWallet ?? "";
  show("#connect-signer", !!approvalWallet);
  $("#signer-address").textContent = !approvalWallet
    ? "등록된 승인 지갑이 없습니다."
    : !address
      ? "승인 지갑 연결 대기"
      : address.toLowerCase() === approvalWallet.toLowerCase()
        ? `${connectedWalletName ?? "지갑"} 연결됨`
        : `지금 연결한 ${short(address)} 주소와 다릅니다. 승인 지갑을 선택하세요.`;
}

async function refreshLoginWallets() {
  const epoch = sessionEpoch;
  const result = await api("/account/login-wallets");
  if (epoch !== sessionEpoch || !token) return;
  const wallets: NamedWallet[] = result.wallets;
  walletAliases.remember(wallets);
  const loginAddress = sessionStorage.getItem("metanomic-login-wallet");
  const isLoginWallet = (wallet: NamedWallet) =>
    wallet.address.toLowerCase() === loginAddress?.toLowerCase();
  renderCurrentLoginWallet(loginAddress, wallets.find(isLoginWallet)?.alias);
  $("#login-wallet-count").textContent = `${wallets.length}개`;
  approvalWallet = result.signingWallet ?? undefined;
  renderSigningWallet();
  renderLoginWallets(
    $("#login-wallets"),
    wallets,
    loginAddress,
    async (wallet) => {
      if (epoch !== sessionEpoch || !token)
        throw new Error("다시 로그인하세요.");
      const saved: NamedWallet = await api(
        "/account/login-wallets/alias",
        wallet,
        "PUT",
      );
      if (epoch === sessionEpoch && token) {
        walletAliases.remember([saved]);
        if (isLoginWallet(saved))
          renderCurrentLoginWallet(loginAddress, saved.alias);
      }
      return saved;
    },
  );
}
async function signWalletChallenge(path: string) {
  const challenge = await api(path, {
    address,
    deploymentId: asset.activeDeploymentId,
  });
  const provider = await signingProvider();
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHex(challenge.message), address],
  });
  await assertWalletSession(provider, address!, walletChainId!);
  return { challengeId: challenge.challengeId, signature };
}
function saveSession(
  result: any,
  loginAddress?: string,
  expectedEpoch = sessionEpoch,
) {
  if (expectedEpoch !== sessionEpoch) {
    void fetch("/v1/sessions/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${result.token}` },
    }).catch(() => {});
    throw new Error("연결이 초기화된 로그인 요청입니다. 다시 로그인하세요.");
  }
  token = result.token;
  sessionStorage.setItem("metanomic-session", token);
  if (loginAddress)
    sessionStorage.setItem("metanomic-login-wallet", loginAddress);
  else sessionStorage.removeItem("metanomic-login-wallet");
}
const gameName = (gameId: string) =>
  catalogGames.find((g) => g.id === gameId)?.name ?? gameId;
async function waitOperation(operationId: string, announce = true) {
  for (let i = 0; i < 100; i++) {
    const op = await api(`/operations/${operationId}`);
    if (op.status === "FINALIZED") return op;
    if (op.status === "FAILED") throw new Error(op.error ?? "작업 실패");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (announce)
    toast(
      "작업을 계속 확인하고 있습니다. 활동 내역에서 진행 상태를 확인하세요.",
    );
}

let actionRun: ((feedback: HTMLElement) => Promise<void>) | undefined;
const actionDialog = $<HTMLDialogElement>("#action-dialog");
const actionFeedback = $("#action-progress");
function showAction(
  title: string,
  details: string,
  label: string,
  run: NonNullable<typeof actionRun>,
) {
  actionRun = run;
  $("#action-title").textContent = title;
  $("#action-details").innerHTML = details;
  $("#confirm-action").textContent = label;
  actionFeedback.textContent = "";
  actionFeedback.classList.remove("feedback-error");
  actionDialog.showModal();
}
actionDialog.addEventListener("close", () => {
  if (!actionDialog.open) actionRun = undefined;
});
on("#cancel-action", "click", () => actionDialog.close());
actionDialog.addEventListener("cancel", (e) => {
  if ($<HTMLButtonElement>("#confirm-action").disabled) e.preventDefault();
});
on("#confirm-action", "click", async () => {
  const cancel = $<HTMLButtonElement>("#cancel-action");
  cancel.disabled = true;
  actionFeedback.classList.remove("feedback-error");
  actionFeedback.textContent = "요청을 준비하고 있습니다…";
  try {
    await actionRun?.(actionFeedback);
    actionDialog.close();
  } catch (error) {
    actionFeedback.textContent = walletErrorMessage(error);
    actionFeedback.classList.add("feedback-error");
  } finally {
    cancel.disabled = false;
  }
});

async function refreshPlayer() {
  const [balances, activity, catalog, applications] = await Promise.all([
    api("/players/me/balances"),
    api("/players/me/activity"),
    api("/games"),
    api("/operator-applications"),
  ]);
  catalogGames = catalog.games;
  renderCatalog(catalog.games);
  renderOperatorApplication(applications.applications[0]);
  const current = balances.balances.find(
    (b: any) => b.deploymentId === asset.activeDeploymentId,
  );
  renderPlayerBalance($("#player-balance"), current);
  const loginAddress = sessionStorage.getItem("metanomic-login-wallet");
  $("#balance-wallet-note").textContent = current?.address
    ? current.address.toLowerCase() === loginAddress?.toLowerCase()
      ? "이 지갑의 CGC 잔액을 조회하고 있어요."
      : `포털에서 CGC 잔액을 조회하는 지갑은 ${current.address}입니다.`
    : "포털에서 조회할 CGC 지갑이 아직 없습니다.";
  show("#balance-wallet-note", true);
  const rows = [
    ...activity.payments.map((p: any) => ({
      label: `${gameName(p.game_id)} · ${p.payload.item.name} · ${format(p.payload.amount)} CGC`,
      detail: p.id,
      status: p.status,
      paymentId: p.id,
    })),
    ...activity.rewards.map((r: any) => ({
      label: `${gameName(r.gameId)} 보상 · +${format(r.amount)} CGC`,
      detail: r.rewardRef,
      status: r.operation?.status ?? "QUEUED",
    })),
  ];
  $("#activity").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="activity-row"><div><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></div><div class="actions">${pill(r.status)}${r.status === "CREATED" ? `<button data-checkout="${esc(r.paymentId)}">결제하기</button>` : ""}${r.status === "PAID" ? `<button data-refund="${esc(r.paymentId)}">환불</button>` : ""}</div></div>`,
        )
        .join("")
    : '<p class="muted">게임에서 보상을 받거나 공통 코인으로 결제하면 이곳에 표시됩니다.</p>';
  const waiting = activity.payments.filter((p: any) => p.status === "CREATED");
  const pending = $("#pending-checkout");
  const next = waiting[0];
  const pendingContent = next
    ? `<div class="section-heading tight"><h2>승인할 결제 ${waiting.length}건</h2></div><p>${esc(gameName(next.game_id))} · ${esc(next.payload.item.name)} · ${esc(format(next.payload.amount))} CGC</p><div class="actions"><button type="button" class="primary" data-checkout="${esc(next.id)}">결제 이어하기</button>${waiting.length > 1 ? '<button type="button" data-goto="activity">전체 주문 보기</button>' : ""}</div>`
    : "";
  if (pending.innerHTML !== pendingContent) pending.innerHTML = pendingContent;
  show("#pending-checkout", !!next);
  setTabCount("activity", waiting.length);
  document.querySelectorAll<HTMLButtonElement>("[data-refund]").forEach(
    (b) =>
      (b.onclick = () =>
        void api(`/payments/${b.dataset.refund}/refunds`, {})
          .then(() => toast("환불을 접수했습니다."))
          .catch((e) => toast(e.message, true))),
  );
  updatePlayerGuide({
    games: catalog.games,
    payments: activity.payments,
    rewards: activity.rewards,
  });
}
const PURCHASED = ["PAID", "DELIVERY_CLAIMED", "COMPLETED"];
function updatePlayerGuide(state: {
  games: any[];
  payments: any[];
  rewards: any[];
}) {
  const playable = state.games.find((g) => g.playUrl);
  const purchased = state.payments.some((p) => PURCHASED.includes(p.status));
  const launch = playable
    ? {
        label: `${playable.name} 열기`,
        click: `[data-launch="${playable.id}"]`,
      }
    : undefined;
  const steps: Step[] = [
    {
      title: "게임에서 지갑으로 로그인",
      detail: state.games.length
        ? "게임을 열고 지갑으로 로그인하세요."
        : "참여 게임이 등록되면 이곳에서 열 수 있습니다.",
      done: state.rewards.length > 0 || state.payments.length > 0,
      action: launch,
    },
    {
      title: "게임에서 CGC 받기",
      detail: "보상 조건을 달성하면 지갑으로 지급됩니다.",
      done: state.rewards.some((r) => r.operation?.status === "FINALIZED"),
      action: launch,
    },
    {
      title: "CGC로 구매하기",
      detail: "게임에서 CGC 결제를 선택하고 지갑으로 승인하세요.",
      done: purchased,
      action: launch,
    },
  ];
  renderSteps("#player-steps", "#player-steps-progress", steps);
}
function renderCatalog(games: any[]) {
  const next = JSON.stringify(games);
  if (next === catalogKey) return;
  catalogKey = next;
  $("#catalog-count").textContent = `${games.length}개`;
  $("#game-catalog").innerHTML =
    games
      .map((g, index) => {
        const hue = (index * 67 + 160) % 360;
        const host = g.playUrl ? new URL(g.playUrl).host : "";
        const launch = g.playUrl
          ? `<a class="primary catalog-launch" href="${esc(g.playUrl)}" target="_blank" rel="noopener noreferrer" data-launch="${esc(g.id)}" aria-label="${esc(g.name)} 게임 실행">플레이 ↗</a>`
          : '<span class="muted">준비 중</span>';
        return `<article class="game-card" style="--hue:${hue}"><span class="game-tile" aria-hidden="true">${esc(Array.from(String(g.name))[0] ?? "")}</span><div class="game-content"><h2>${esc(g.name)}</h2><span class="game-meta">${esc([g.category, host].filter(Boolean).join(" · "))}</span><p>${esc(g.description || "")}</p></div>${launch}</article>`;
      })
      .join("") ||
    '<div class="panel empty-state"><p class="muted">아직 등록된 게임이 없습니다.</p></div>';
}
function renderOperatorApplication(latest: any) {
  const status = $("#operator-application-status");
  const pending = latest?.status === "PENDING";
  const approved = latest?.status === "APPROVED";
  show("#operator-application-form", !pending && !approved);
  status.innerHTML = !latest
    ? ""
    : `<div class="application-status ${latest.status.toLowerCase()}"><div class="actions">${applicationPill(latest.status)}<strong>${esc(latest.displayName)}</strong></div><p>${esc(
        pending
          ? "관리자가 검토하고 있습니다. 승인되면 이 계정이 운영자 계정으로 전환됩니다."
          : approved
            ? "승인됐습니다. 운영자 화면으로 전환하세요."
            : `반려됐습니다: ${latest.reviewNote ?? ""} 내용을 보완해 다시 신청할 수 있습니다.`,
      )}</p><small>승인 지갑 ${esc(latest.wallet)}</small>${approved ? '<button type="button" class="primary" data-reload>운영자 화면으로 전환 →</button>' : ""}</div>`;
  $("#operator-application-wallet").textContent = address
    ? `서명 지갑 ${short(address)}`
    : "";
  setTabCount("apply", approved ? 1 : 0);
}
async function checkout(paymentId: string) {
  const dialog = $<HTMLDialogElement>("#checkout");
  if (checkoutLoading || dialog.open) return;
  checkoutLoading = true;
  try {
    currentPayment = await api(`/payments/${paymentId}`);
  } finally {
    checkoutLoading = false;
  }
  if (currentPayment.status !== "CREATED") {
    toast("결제 상태가 바뀌었습니다. 나의 활동에서 최신 상태를 확인하세요.");
    await refreshPlayer();
    return;
  }
  $("#checkout-progress").textContent = "";
  $("#checkout-progress").classList.remove("feedback-error");
  $("#checkout-details").innerHTML =
    `<p>${esc(gameName(currentPayment.gameId))}</p><h2>${esc(currentPayment.item.name)}</h2><div class="activity-row"><span>수량 ${esc(currentPayment.item.quantity)}</span><strong>${esc(format(currentPayment.amount))} CGC</strong></div>`;
  $("#authorize-payment").textContent =
    `${format(currentPayment.amount)} CGC 결제 승인`;
  dialog.showModal();
}
function selectOperatorGame(gameId: string) {
  const picker = $<HTMLSelectElement>("#operator-game-select");
  picker.value = gameId;
  if (picker.selectedIndex < 0 && picker.options.length)
    picker.selectedIndex = 0;
  selectedOperatorGameId = picker.value;
  for (const card of document.querySelectorAll<HTMLElement>(
    "[data-operator-game], [data-integration-game]",
  )) {
    card.hidden =
      (card.dataset.operatorGame ?? card.dataset.integrationGame) !==
      selectedOperatorGameId;
  }
}
on("#operator-game-select", "change", (event) => {
  selectOperatorGame((event.target as HTMLSelectElement).value);
});

async function refreshOperator() {
  const [owned, submitted] = await Promise.all([
    api("/operator/games"),
    api("/game-registrations"),
  ]);
  const games = owned.games;
  operatorRegistrations = submitted.registrations;
  renderTable<any>($("#operator-registrations"), {
    rows: submitted.registrations,
    key: (r) => r.registrationId,
    searchPlaceholder: "게임 이름·ID 검색",
    searchText: (r) => `${r.name} ${r.gameId}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "검토 대기", match: byStatus("PENDING", "REGISTERING") },
      { label: "승인", match: byStatus("APPROVED") },
      { label: "반려·실패", match: byStatus("REJECTED", "FAILED") },
    ],
    columns: [
      {
        label: "게임",
        cell: (r) =>
          `<strong>${esc(r.name)}</strong><small>${esc(r.gameId)}</small>`,
      },
      { label: "신청일", cell: (r) => day(r.submittedAt), className: "nowrap" },
      { label: "상태", cell: (r) => pill(r.status) },
    ],
    detail: (r) =>
      detailList([
        [
          "안내",
          esc(
            r.status === "PENDING"
              ? "관리자 검토를 기다리고 있습니다."
              : r.status === "REGISTERING"
                ? "계약 등록이 확정되면 이용자에게 공개됩니다."
                : r.status === "APPROVED"
                  ? "승인됐습니다. [내 게임]에서 관리하세요."
                  : r.status === "REJECTED"
                    ? "내용을 보완해 [다시 신청]하세요. 같은 게임 ID로 신청됩니다."
                    : "관리자가 계약 등록을 다시 시도합니다.",
          ),
        ],
        ["반려 사유", esc(r.reviewNote ?? "")],
        ["오류", esc(r.error ?? "")],
        ["소개", esc(r.description ?? "")],
      ]),
    actions: (r) =>
      r.status === "REJECTED"
        ? `<button type="button" class="small" data-resubmit="${esc(r.registrationId)}">다시 신청</button>`
        : "",
    empty: "아직 등록 신청이 없습니다.",
  });
  // Budget reads round-trip to the chain RPC (~2s each), so cards render from the
  // local records first and the budget figures are filled in once all games answer.
  const budgetsRequest = Promise.all(
    games.map((game: any) => api(`/games/${game.id}/budget`)),
  );
  // Handled below once the cards are drawn; this only avoids an early unhandled rejection.
  budgetsRequest.catch(() => {});
  const views = await Promise.all(
    games.map(async (game: any) => {
      const [actions, payments, rewards, credentials, webhooks] =
        await Promise.all([
          api(`/games/${game.id}/budget-actions`),
          api(`/games/${game.id}/payments`),
          api(`/games/${game.id}/rewards`),
          api(`/games/${game.id}/credentials`),
          api(`/games/${game.id}/webhooks`),
        ]);
      return {
        game,
        budget: undefined as any,
        actions: actions.actions,
        payments: payments.payments,
        rewards: rewards.rewards,
        credentials: credentials.credentials,
        webhooks: webhooks.webhooks,
      };
    }),
  );
  renderOperatorOverview(submitted.registrations, views);
  $("#operator-games").innerHTML =
    views
      .map(({ game, actions, payments, rewards, credentials }) => {
        const liveCredentials = credentials.filter((c: any) => !c.revoked);
        return `<article class="panel operator-game" data-operator-game="${esc(game.id)}"><header class="operator-game-head"><div><span class="eyebrow">${esc(game.id)}</span><h2>${esc(game.name)}</h2></div>${pill(game.active ? "ACTIVE" : "INACTIVE")}</header><div class="mini-stats"><div><strong class="loading" data-budget-available="${esc(game.id)}">확인 중</strong><span>사용 가능 예산</span></div><div><strong class="loading" data-budget-reserved="${esc(game.id)}">확인 중</strong><span>지급·인출 대기</span></div><div><strong class="${payments.length ? "warn" : ""}">${payments.length}</strong><span>미완료 결제</span></div></div><div class="operator-game-body"><section class="op-block"><h3>보상 예산</h3><form class="operator-form" data-budget-form="${esc(game.id)}"><label>금액 (CGC)<input name="amount" inputmode="decimal" placeholder="0.000000" maxlength="85" required></label><label>작업<select name="kind"><option value="deposits">추가 예치</option><option value="withdrawals">예산 인출</option></select></label><button type="submit" class="primary" data-budget-preview>예치 내용 확인</button></form><p class="operation-feedback muted" data-budget-feedback role="status"></p></section><section class="op-block"><h3>게임 서버 연결</h3><p>${liveCredentials.length ? `<span class="pill" data-credential-count="${esc(game.id)}">발급된 키 ${liveCredentials.length}개</span>` : `<span class="pill pending" data-credential-count="${esc(game.id)}">키 미발급</span>`}</p><button type="button" data-goto="integration" data-operator-game-target="${esc(game.id)}">연결 정보와 API 키 보기 →</button></section><section class="op-block"><h3>정산 속도</h3><p class="muted">완료로 볼 확인 블록 수. 작을수록 빠르지만 체인 재구성에 취약합니다.</p><form class="operator-form" data-settlement-form="${esc(game.id)}"><label>확인 블록 수<input name="confirmations" type="number" min="1" max="1000" step="1" placeholder="서버 기본값" value="${game.confirmations ?? ""}"></label><button type="submit">저장</button></form></section></div><details class="op-history"${payments.length ? " open" : ""}><summary>최근 내역 · 미완료 결제 ${payments.length}건</summary><div class="op-history-grid"><div><h3>미완료 결제</h3>${payments.map((p: any) => `<div class="activity-row"><div><strong>${esc(p.item.name)}</strong><small>${esc(p.paymentId)}</small></div>${pill(p.status)}</div>`).join("") || '<p class="muted">미완료 결제가 없습니다.</p>'}</div><div><h3>보상 지급 결과</h3>${
          rewards
            .slice(0, 5)
            .map(
              (r: any) =>
                `<div class="activity-row"><div><strong>${esc(format(r.amount))} CGC</strong><small>${esc(r.rewardRef)}</small></div>${pill(r.status)}</div>`,
            )
            .join("") || '<p class="muted">아직 보상이 없습니다.</p>'
        }</div><div><h3>예치·인출</h3>${
          actions
            .filter((action: any) => action.status !== "CREATED")
            .slice(0, 5)
            .map(
              (a: any) =>
                `<div class="activity-row"><span>${a.kind === "deposits" ? "예치" : "인출"} ${format(a.payload.amount)} CGC</span>${pill(a.status, a.status === "PROCESSING" ? "블록체인 확정 대기" : undefined)}</div>`,
            )
            .join("") || '<p class="muted">아직 내역이 없습니다.</p>'
        }</div></div></details></article>`;
      })
      .join("") ||
    '<div class="panel empty-state"><h2>아직 운영 중인 게임이 없습니다</h2><p class="muted">게임이 승인되면 여기서 예산과 연동을 관리합니다.</p><button type="button" class="primary" data-goto="register">게임 등록 신청하기 →</button></div>';
  renderOperatorIntegration($("#operator-integration"), views, {
    apiUrl: new URL("/v1", location.origin).href,
    assetId: asset.assetId,
    guideUrl: INTEGRATION_GUIDE_URL,
    issue: async (gameId, label) => {
      const result = await api(`/games/${gameId}/credentials`, {
        label,
        scopes: ["links", "rewards", "payments", "events", "budget"],
      });
      const view = views.find((entry) => entry.game.id === gameId)!;
      view.credentials.unshift({
        id: result.credentialId,
        label: result.label,
        scopes: result.scopes,
        createdAt: Date.now(),
      });
      const count = Array.from(
        document.querySelectorAll<HTMLElement>("[data-credential-count]"),
      ).find((element) => element.dataset.credentialCount === gameId);
      if (count) {
        count.textContent = `발급된 키 ${view.credentials.length}개`;
        count.className = "pill";
      }
      renderOperatorOverview(submitted.registrations, views);
      return result;
    },
    revoke: async (gameId, credentialId) => {
      await api(
        `/games/${gameId}/credentials/${credentialId}`,
        undefined,
        "DELETE",
      );
      toast("API 키를 폐기했습니다.");
      await refreshOperator();
    },
    createWebhook: (gameId, url, label) =>
      api(`/games/${gameId}/webhooks`, { url, label }),
    testWebhook: (gameId, webhookId) =>
      api(`/games/${gameId}/webhooks/${webhookId}/tests`, {}),
    deleteWebhook: async (gameId, webhookId) => {
      await api(`/games/${gameId}/webhooks/${webhookId}`, undefined, "DELETE");
    },
    feedback: toast,
  });
  document.querySelectorAll<HTMLFormElement>("[data-settlement-form]").forEach(
    (form) =>
      (form.onsubmit = (e) => {
        e.preventDefault();
        const raw = new FormData(form).get("confirmations")?.toString().trim();
        const confirmations = raw ? Number(raw) : null;
        void api(
          `/games/${form.dataset.settlementForm}/settlement`,
          { confirmations },
          "PUT",
        )
          .then(() =>
            toast(
              confirmations
                ? `${confirmations}블록 확인 후 완료로 처리합니다.`
                : "서버 기본값을 따릅니다.",
            ),
          )
          .catch((error) => toast(error.message, true));
      }),
  );
  const picker = $<HTMLSelectElement>("#operator-game-select");
  picker.replaceChildren(
    ...views.map(({ game }) => new Option(game.name, game.id)),
  );
  selectOperatorGame(selectedOperatorGameId);
  show("#operator-game-picker", views.length > 0);
  for (const { game, actions } of views) {
    const form = $<HTMLFormElement>(
      `[data-budget-form="${CSS.escape(game.id)}"]`,
    );
    form.onchange = () => {
      form.querySelector<HTMLElement>("[data-budget-preview]")!.textContent =
        new FormData(form).get("kind") === "deposits"
          ? "예치 내용 확인"
          : "인출 내용 확인";
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      previewBudget(form, game);
    };
    renderBudgetFeedback(game.id, actions);
  }
  const fillBudgets = (text: (gameId: string, key: string) => string) =>
    document
      .querySelectorAll<HTMLElement>(
        "[data-budget-available], [data-budget-reserved]",
      )
      .forEach((el) => {
        const key = el.dataset.budgetAvailable ? "available" : "reserved";
        el.textContent = text(
          el.dataset.budgetAvailable ?? el.dataset.budgetReserved!,
          key,
        );
        el.classList.remove("loading");
      });
  let budgets: any[];
  try {
    budgets = await budgetsRequest;
  } catch (error) {
    fillBudgets(() => "확인 실패");
    throw error;
  }
  const byGame = new Map<string, any>(
    games.map((g: any, i: number) => [g.id, budgets[i]]),
  );
  fillBudgets((gameId, key) => format(byGame.get(gameId)[key]));
  for (const view of views) view.budget = byGame.get(view.game.id);
  renderOperatorOverview(submitted.registrations, views);
}
function renderOperatorOverview(registrations: any[], views: any[]) {
  const inReview = registrations.filter((r) =>
    ["PENDING", "REGISTERING"].includes(r.status),
  );
  const needsFix = registrations.filter((r) =>
    ["REJECTED", "FAILED"].includes(r.status),
  );
  const first = views[0];
  const hasCredential = views.some((v) =>
    v.credentials.some((c: any) => !c.revoked),
  );
  // Budgets arrive after the first render; until then the budget step stays open.
  const budgetsLoading = views.some((v) => !v.budget);
  const funded = views.some((v) => Number(v.budget?.available ?? 0) > 0);
  const steps: Step[] = [
    {
      title: "게임 등록 신청",
      detail: needsFix.length
        ? `반려·실패한 신청 ${needsFix.length}건이 있습니다. 내용을 보완해 다시 신청하세요.`
        : "이름·실행 주소·소개를 입력하세요.",
      done: (registrations.length > 0 || views.length > 0) && !needsFix.length,
      action: { label: "등록 신청서 작성", goto: "register" },
    },
    {
      title: "관리자 승인 대기",
      detail: inReview.length
        ? `${inReview.length}건을 검토하고 있습니다. 승인되면 이용자 게임 목록에 공개됩니다.`
        : "신청 후 네트워크 운영자의 승인을 기다립니다.",
      done: views.length > 0,
      action: inReview.length
        ? { label: "신청 현황 보기", goto: "register" }
        : undefined,
    },
    {
      title: "게임 서버 연결 정보 확인",
      detail: "API 주소·게임 ID를 복사하고 API 키를 발급하세요.",
      done: hasCredential,
      action: first
        ? {
            label: "연결 정보 보기",
            goto: "integration",
            gameId: first.game.id,
            focus: `[data-integration-game="${CSS.escape(first.game.id)}"] h2`,
          }
        : undefined,
    },
    {
      title: "보상 예산 확보",
      detail: budgetsLoading
        ? "블록체인에서 예산을 확인하고 있습니다…"
        : "신규 게임의 예산은 0입니다. 직접 예치하거나 관리자의 배분을 받으세요.",
      done: funded,
      action: first
        ? {
            label: "예치 금액 입력",
            gameId: first.game.id,
            focus: `[data-budget-form="${first.game.id}"] input[name=amount]`,
          }
        : undefined,
    },
  ];
  renderSteps("#operator-steps", "#operator-steps-progress", steps);
  const sum = (key: "available" | "reserved") =>
    budgetsLoading
      ? "확인 중"
      : `${format(String(views.reduce((total, v) => total + Number(v.budget[key]), 0)))} CGC`;
  const openPayments = views.reduce((n, v) => n + v.payments.length, 0);
  $("#operator-summary").innerHTML = [
    [
      "운영 중 게임",
      `${views.filter((v) => v.game.active).length} / ${views.length}`,
      "",
    ],
    ["사용 가능 예산", sum("available"), ""],
    ["지급·인출 대기", sum("reserved"), ""],
    ["미완료 결제", `${openPayments}건`, openPayments ? "warn" : ""],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="stat ${tone}"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  setTabCount(
    "register",
    needsFix.length || inReview.length,
    needsFix.length ? "failed" : "pending",
  );
  setTabCount("games", openPayments);
}
const budgetProgress = new Map<
  string,
  { actionId: string; message: string; error?: boolean }
>();
function renderBudgetFeedback(gameId: string, actions?: any[]) {
  const field = document.querySelector<HTMLElement>(
    `[data-budget-form="${CSS.escape(gameId)}"] + [data-budget-feedback]`,
  );
  if (!field) return;
  const progress = budgetProgress.get(gameId);
  const recorded = actions?.find(
    (action) =>
      action.status !== "CREATED" &&
      (!progress || action.id === progress.actionId),
  );
  if (
    recorded &&
    (!progress || ["FINALIZED", "FAILED"].includes(recorded.status))
  ) {
    const label = recorded.kind === "deposits" ? "예치" : "인출";
    const status =
      recorded.status === "PROCESSING"
        ? "블록체인 확정 대기"
        : (words[recorded.status] ?? recorded.status);
    field.textContent = `최근 ${format(recorded.payload.amount)} CGC ${label} · ${status}`;
    field.classList.toggle("feedback-error", recorded.status === "FAILED");
    return;
  }
  field.textContent = progress?.message ?? "";
  field.classList.toggle("feedback-error", !!progress?.error);
}

function previewBudget(
  form: HTMLFormElement,
  game: { id: string; name: string },
) {
  const data = new FormData(form);
  const amount = String(data.get("amount")).trim();
  const input = form.elements.namedItem("amount") as HTMLInputElement;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount) || Number(amount) <= 0) {
    const error = "0보다 큰 수량을 입력하세요. 소수점 아래는 최대 6자리입니다.";
    const field = form.nextElementSibling as HTMLElement;
    field.textContent = error;
    field.classList.add("feedback-error");
    input.focus();
    return;
  }
  const field = form.nextElementSibling as HTMLElement;
  if (field.classList.contains("feedback-error")) renderBudgetFeedback(game.id);
  const kind = String(data.get("kind"));
  const deposit = kind === "deposits";
  const label = deposit ? "예치" : "인출";
  const wallet = `승인 지갑${me.wallet ? ` · ${short(me.wallet)}` : ""}`;
  const budget = `${game.name}의 보상 예산`;
  showAction(
    `${label} 내용을 확인하세요`,
    detailList([
      ["게임", esc(game.name)],
      ["금액", `${esc(amount)} CGC`],
      ["보내는 곳", esc(deposit ? wallet : budget)],
      ["받는 곳", esc(deposit ? budget : wallet)],
      [
        "지갑 서명",
        deposit ? "예치 승인과 CGC 사용 승인, 총 2회" : "인출 승인 1회",
      ],
    ]),
    `${label} 서명 시작`,
    (feedback) => budgetAction(game.id, kind, amount, label, feedback),
  );
}

async function budgetAction(
  gameId: string,
  kind: string,
  amount: string,
  label: string,
  feedback: HTMLElement,
) {
  const epoch = sessionEpoch;
  feedback.textContent = "운영자 승인 지갑을 확인하고 있습니다…";
  if (!localAccount) await signingProvider();
  if (me.wallet && address?.toLowerCase() !== me.wallet.toLowerCase())
    throw new Error(
      "현재 지갑이 운영자 승인 지갑과 다릅니다. [지갑] 메뉴에서 예치·인출 승인 지갑을 연결하세요.",
    );
  const prepared = await api(`/games/${gameId}/${kind}`, {
    assetId: asset.assetId,
    amount,
  });
  feedback.textContent =
    kind === "deposits"
      ? "1/2 지갑 앱에서 예치 승인에 서명하세요."
      : "지갑 앱에서 인출 승인에 서명하세요.";
  const signature = await signTyped(prepared.signingRequest);
  let permitSignature, permitDeadline;
  if (kind === "deposits") {
    const list = await api(`/games/${gameId}/budget-actions`);
    const action = list.actions.find((a: any) => a.id === prepared.actionId);
    if (!action?.permit)
      throw new Error("CGC 사용 승인을 준비하지 못했습니다. 다시 시도하세요.");
    feedback.textContent = "2/2 지갑 앱에서 CGC 사용 승인에 서명하세요.";
    permitSignature = await signTyped(action.permit);
    permitDeadline = action.expires_at;
  }
  feedback.textContent = `${label} 요청을 제출하고 있습니다…`;
  const result = await api(
    `/games/${gameId}/${kind}/${prepared.actionId}/authorizations`,
    { signature, permitSignature, permitDeadline },
  );
  if (epoch !== sessionEpoch) return;
  const progress = {
    actionId: prepared.actionId,
    message: `${amount} CGC ${label} 접수 · 블록체인 확정 대기`,
    error: false,
  };
  budgetProgress.set(gameId, progress);
  renderBudgetFeedback(gameId);
  void waitOperation(result.operationId, false)
    .then((operation) => {
      progress.message = operation
        ? `${amount} CGC ${label} 완료 · 새로고침으로 변경된 예산을 확인하세요.`
        : `${amount} CGC ${label} 확정 대기 · 새로고침으로 예치·인출 내역을 확인하세요.`;
    })
    .catch((error) => {
      progress.message = `예치·인출 내역에서 ${label} 상태를 확인하세요. ${walletErrorMessage(error)}`;
      progress.error = true;
    })
    .finally(() => {
      if (budgetProgress.get(gameId) === progress) renderBudgetFeedback(gameId);
    });
}
// Same top-up threshold as scripts/fund-relayer.ts.
const RELAYER_GAS_LOW_WEI = parseEther("0.5");
// Measured on Saigon at 21 gwei; only used for a rough "how many left" hint.
const REWARD_GAS_WEI = parseEther("0.002");
const PURCHASE_GAS_WEI = parseEther("0.0082");
const FAUCET_URL = "https://faucet.roninchain.com/";
const EXPLORER_URL = "https://saigon-explorer.roninchain.com";
const INTEGRATION_GUIDE_URL =
  "https://github.com/superwhyun/metanomics/blob/main/docs/GAME_INTEGRATION.md";
// The admin wallet only signs occasional allocations and issuances (~0.003 RON each).
const ADMIN_GAS_LOW_WEI = parseEther("0.1");
interface GasWallet {
  label: string;
  address: string;
  balanceWei: string;
  lowWei: bigint;
  lowNote: string;
  hint: (balance: bigint) => string;
}
function gasRow(wallet: GasWallet, local: boolean, extra = "") {
  const balance = BigInt(wallet.balanceWei);
  const low = balance < wallet.lowWei;
  const ron = Number(formatEther(balance)).toLocaleString("ko-KR", {
    maximumFractionDigits: 4,
  });
  const address = esc(wallet.address);
  const explorer = local
    ? ""
    : `<a class="text-link" href="${EXPLORER_URL}/address/${address}" target="_blank" rel="noopener noreferrer">탐색기 ↗</a>`;
  const faucet = local
    ? ""
    : `<a class="${low ? "primary" : ""} button-link" href="${FAUCET_URL}" target="_blank" rel="noopener noreferrer" data-copy="${address}" title="주소를 복사하고 Faucet(하루 1회 5 RON)을 엽니다">Faucet ↗</a>`;
  return {
    low,
    html: `<article class="panel gas-panel${low ? " low" : ""}"><div class="gas-balance"><span>${esc(wallet.label)}</span><strong>${ron} RON</strong><small>${low ? esc(wallet.lowNote) : esc(wallet.hint(balance))}</small></div><div class="gas-address"><code title="${address}">${esc(short(wallet.address))}</code><button type="button" class="quiet small" data-copy="${address}">주소 복사</button>${explorer}</div><div class="gas-actions actions">${extra}${faucet}</div></article>`,
  };
}
const ron = (wei: string | bigint) =>
  Number(formatEther(BigInt(wei))).toLocaleString("ko-KR", {
    maximumFractionDigits: 4,
  });
function renderRelayerGas(deployment: any, accounting: any, funding: any) {
  const local = deployment.finality === "local";
  const relayer = gasRow(
    {
      label: "중계 지갑",
      address: deployment.relayer,
      balanceWei: accounting.relayerGasWei,
      lowWei: RELAYER_GAS_LOW_WEI,
      lowNote: "0.5 RON 미만 · 바닥나면 보상·결제가 멈춥니다",
      hint: (b) =>
        `보상 약 ${(b / REWARD_GAS_WEI).toLocaleString("ko-KR")}건 · 구매 약 ${(b / PURCHASE_GAS_WEI).toLocaleString("ko-KR")}건 분량`,
    },
    local,
    '<button type="button" class="small" data-fund-relayer>관리자 지갑에서 충전</button>',
  );
  const admin = gasRow(
    {
      label: "관리자 지갑",
      address: deployment.admin,
      balanceWei: accounting.adminGasWei,
      lowWei: ADMIN_GAS_LOW_WEI,
      lowNote: "0.1 RON 미만 · 바닥나면 배분·발행이 멈춥니다",
      hint: () => "배분·게임 등록·발행용",
    },
    local,
  );
  const auto = funding.auto
    ? `자동 충전 켜짐 · 중계 지갑 ${ron(funding.auto.minWei)} RON 미만이면 ${ron(funding.auto.topupWei)} RON 충전 (관리자 지갑 ${ron(funding.auto.adminMinWei)} RON 유지)`
    : "자동 충전 꺼짐 (RELAYER_AUTO_FUND=0)";
  const recent = funding.recent
    .slice(0, 5)
    .map(
      (f: any) =>
        `<div class="activity-row"><div><strong>${f.trigger === "auto" ? "자동" : "수동"} 충전 · ${esc(ron(f.amountWei))} RON</strong><small>${esc(f.error ?? new Date(f.createdAt).toLocaleString("ko-KR"))}</small></div>${pill(f.status)}</div>`,
    )
    .join("");
  $("#relayer-gas").innerHTML =
    relayer.html +
    admin.html +
    `<div class="panel gas-auto"><p class="muted">${esc(auto)}</p>${funding.warning ? `<p class="gas-warning">${esc(funding.warning)}</p>` : ""}${recent ? `<h3>최근 충전</h3>${recent}` : ""}</div>`;
  return relayer.low || admin.low || !!funding.warning;
}
const ISSUANCE_STEPS_TOTAL: Record<string, string> = {
  MINTING: "1/3 발행",
  APPROVING: "2/3 충전 승인",
  FUNDING: "3/3 보유분 입금",
};
function renderIssuance(data: any) {
  const a = data.accounting;
  const supply = cgcUnits(a.totalSupply);
  const cap = cgcUnits(a.supplyCap);
  $("#supply-remaining").textContent =
    supply !== undefined && cap !== undefined
      ? cgcLabel(cap > supply ? cap - supply : 0n)
      : "—";
  $("#supply-totals").textContent =
    supply !== undefined && cap !== undefined
      ? `발행량 ${cgcLabel(supply)} / 한도 ${cgcLabel(cap)} CGC`
      : "";
  const operators = data.accounts.filter((o: any) => o.wallet);
  const select = $<HTMLSelectElement>("#issuance-operator");
  const options =
    `<option value="">${operators.length ? "운영자 선택" : "지갑이 등록된 운영자 없음"}</option>` +
    operators
      .map(
        (o: any) =>
          `<option value="${esc(o.id)}">${esc(o.username)} · ${esc(short(o.wallet))}</option>`,
      )
      .join("");
  if (select.innerHTML !== options) {
    const value = select.value;
    select.innerHTML = options;
    if (Array.from(select.options).some((o) => o.value === value))
      select.value = value;
  }
  const operatorName = (wallet: string) =>
    operators.find((o: any) => o.wallet.toLowerCase() === wallet.toLowerCase())
      ?.username ?? short(wallet);
  $("#issuance-history").innerHTML =
    data.issuances
      .map(
        (i: any) =>
          `<div class="activity-row"><div><strong>${i.target === "reserve" ? "보유분 충전" : `운영자 지갑 · ${esc(operatorName(i.recipient))}`} · +${esc(format(i.amount))} CGC</strong><small>${esc(i.error ?? `${ISSUANCE_STEPS_TOTAL[i.status] ?? ""} ${new Date(i.createdAt).toLocaleString("ko-KR")}`)}</small></div>${pill(i.status)}</div>`,
      )
      .join("") || '<p class="muted">아직 추가 발행 기록이 없습니다.</p>';
  $("#issuance-count").textContent = data.issuances.length
    ? `최근 ${data.issuances.length}건`
    : "";
  renderIssuanceFeedback();
}

function renderIssuanceFeedback() {
  const form = $<HTMLFormElement>("#issuance-form");
  const target = $<HTMLSelectElement>("#issuance-target").value;
  const operator = $<HTMLSelectElement>("#issuance-operator");
  const forOperator = target === "operator";
  operator.required = forOperator;
  $("#issuance-operator-label").hidden = !forOperator;
  const text = String(new FormData(form).get("amount") ?? "").trim();
  const value = cgcUnits(text);
  const accounting = latestOverview?.accounting;
  const supply = cgcUnits(accounting?.totalSupply ?? "");
  const cap = cgcUnits(accounting?.supplyCap ?? "");
  const ready = supply !== undefined && cap !== undefined;
  const error =
    ready && value && value + supply > cap
      ? "발행 한도까지 남은 수량을 넘었어요. 수량을 줄이세요."
      : text && !value
        ? "0보다 큰 수량을 입력하세요. 소수점 아래는 6자리까지 입력할 수 있어요."
        : forOperator && operator.options.length <= 1
          ? "지갑이 등록된 운영자가 없습니다."
          : "";
  const feedback = $("#issuance-feedback");
  feedback.textContent = error;
  feedback.classList.toggle("feedback-error", !!error);
  $<HTMLButtonElement>("#issuance-submit").disabled = !ready || !!error;
}
const day = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString("ko-KR") : "—";
const when = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString("ko-KR", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const byStatus =
  (...statuses: string[]) =>
  (row: any) =>
    statuses.includes(row.status);
const rejectForm = (kind: string, id: string) =>
  `<div class="reject-form"><input data-keep="reject-${esc(kind)}-${esc(id)}" data-reject-input="${esc(kind)}:${esc(id)}" maxlength="500" placeholder="반려 사유 (신청자에게 보입니다)"><button type="button" class="danger" data-reject-confirm="${esc(kind)}:${esc(id)}">반려 확정</button></div>`;
const detailList = (items: [string, string][]) =>
  `<dl class="detail-list">${items
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
const OPERATION_LABELS: Record<string, string> = {
  allocate: "예산 배분",
  reward: "보상 지급",
  pay: "결제",
  claimDelivery: "지급 시작",
  fulfill: "지급 완료",
  refund: "환불",
  resolve: "공동 승인 환불",
  budgetAction: "예치·인출",
  registerGame: "게임 체인 기록",
  mint: "CGC 발행",
  approve: "발행분 충전 승인",
  fundReserve: "보유분 입금",
  fundRelayer: "중계 지갑 충전",
};
function renderOperatorApplications(applications: any[]) {
  const rows = [...applications].sort(
    (a, b) =>
      Number(b.status === "PENDING") - Number(a.status === "PENDING") ||
      b.createdAt - a.createdAt,
  );
  renderTable<any>($("#admin-operator-applications"), {
    rows,
    key: (o) => o.applicationId,
    searchPlaceholder: "이름·연락처·지갑 검색",
    searchText: (o) =>
      `${o.displayName} ${o.contact} ${o.wallet} ${o.accountId} ${o.introduction}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "검토 대기", match: byStatus("PENDING") },
      { label: "승인", match: byStatus("APPROVED") },
      { label: "반려", match: byStatus("REJECTED") },
    ],
    columns: [
      {
        label: "신청자",
        cell: (o) => `<strong>${esc(o.displayName)}</strong>`,
      },
      { label: "연락처", cell: (o) => esc(o.contact) },
      {
        label: "승인 지갑",
        cell: (o) => `<code>${esc(short(o.wallet))}</code>`,
      },
      { label: "신청일", cell: (o) => day(o.createdAt), className: "nowrap" },
      { label: "상태", cell: (o) => applicationPill(o.status) },
    ],
    detail: (o) =>
      detailList([
        ["소개", esc(o.introduction)],
        ["승인 지갑", `<code>${esc(o.wallet)}</code>`],
        ["계정", esc(o.accountId)],
        ["반려 사유", esc(o.reviewNote ?? "")],
      ]) +
      (o.status === "PENDING"
        ? rejectForm("application", o.applicationId)
        : ""),
    actions: (o) =>
      o.status === "PENDING"
        ? `<button type="button" class="primary small" data-approve-application="${esc(o.applicationId)}">승인</button><button type="button" class="small" data-reject-open="application:${esc(o.applicationId)}">반려</button>`
        : "",
    empty: "운영자 신청이 없습니다.",
  });
  return applications.filter((o) => o.status === "PENDING").length;
}
function renderRegistrations(registrations: any[]) {
  const rows = [...registrations].sort(
    (a, b) =>
      Number(["PENDING", "FAILED"].includes(b.status)) -
        Number(["PENDING", "FAILED"].includes(a.status)) ||
      (b.submittedAt ?? 0) - (a.submittedAt ?? 0),
  );
  renderTable<any>($("#admin-registrations"), {
    rows,
    key: (r) => r.registrationId,
    searchPlaceholder: "게임 이름·ID·운영자 검색",
    searchText: (r) =>
      `${r.name} ${r.gameId} ${r.operatorId} ${r.category} ${r.playUrl}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "검토 대기", match: byStatus("PENDING") },
      { label: "등록 중", match: byStatus("REGISTERING") },
      { label: "승인", match: byStatus("APPROVED") },
      { label: "반려", match: byStatus("REJECTED") },
      { label: "실패", match: byStatus("FAILED") },
    ],
    columns: [
      {
        label: "게임",
        cell: (r) =>
          `<strong>${esc(r.name)}</strong><small>${esc(r.gameId)}</small>`,
      },
      { label: "운영자", cell: (r) => esc(r.operatorId) },
      { label: "장르", cell: (r) => esc(r.category) },
      { label: "신청일", cell: (r) => day(r.submittedAt), className: "nowrap" },
      { label: "상태", cell: (r) => pill(r.status) },
    ],
    detail: (r) =>
      detailList([
        ["소개", esc(r.description)],
        [
          "실행 주소",
          `<a class="text-link" href="${esc(r.playUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.playUrl)} ↗</a>`,
        ],
        ["반려 사유", esc(r.reviewNote ?? "")],
        ["오류", esc(r.error ?? "")],
      ]) +
      (r.status === "PENDING"
        ? rejectForm("registration", r.registrationId)
        : ""),
    actions: (r) =>
      r.status === "PENDING"
        ? `<button type="button" class="primary small" data-approve-registration="${esc(r.registrationId)}">승인</button><button type="button" class="small" data-reject-open="registration:${esc(r.registrationId)}">반려</button>`
        : r.status === "FAILED"
          ? `<button type="button" class="small" data-approve-registration="${esc(r.registrationId)}">재시도</button>`
          : "",
    empty: "게임 등록 신청이 없습니다.",
  });
}
function renderAdminGames(data: any) {
  renderTable<any>($("#admin-games"), {
    rows: data.games,
    key: (g) => g.id,
    searchPlaceholder: "게임 이름·ID·운영자 검색",
    searchText: (g) => `${g.name} ${g.id} ${g.operator_id}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "포털 켜짐", match: (g) => !!g.active },
      { label: "포털 꺼짐", match: (g) => !g.active },
    ],
    columns: [
      {
        label: "게임",
        cell: (g) =>
          `<strong>${esc(g.name)}</strong><small>${esc(g.id)}</small>`,
      },
      { label: "운영자", cell: (g) => esc(g.operator_id) },
      {
        label: "포털",
        cell: (g) =>
          pill(g.active ? "ACTIVE" : "INACTIVE", g.active ? "켜짐" : "꺼짐"),
      },
      {
        label: "체인",
        cell: (g) =>
          g.chainPending
            ? pill("PENDING", "처리 중")
            : pill(
                g.chainActive ? "ACTIVE" : "INACTIVE",
                g.chainActive ? "켜짐" : "중지",
              ),
      },
    ],
    actions: (g) => {
      const pending = data.registrations.find(
        (r: any) => r.gameId === g.id && r.status !== "APPROVED",
      );
      if (pending) return pill(pending.status);
      const blocked = !g.active && (!g.chainActive || g.chainPending);
      const toggle = `<button type="button" class="small" data-game-toggle="${esc(g.id)}" data-name="${esc(g.name)}" data-active="${g.active ? "1" : "0"}"${blocked ? " disabled" : ""}>${g.active ? "포털에서 끄기" : "포털에서 켜기"}</button>`;
      const chain = g.chainPending
        ? ""
        : `<button type="button" class="small quiet" data-chain-state="${esc(g.id)}" data-active="${g.chainActive ? "0" : "1"}" data-name="${esc(g.name)}">${g.chainActive ? "블록체인에서 중지" : "블록체인에서 재개"}</button>`;
      const remove = g.active
        ? ""
        : `<button type="button" class="small danger" data-game-delete="${esc(g.id)}" data-name="${esc(g.name)}">삭제</button>`;
      const hint = blocked
        ? `<small>${g.chainPending ? "블록체인 작업 확정 후 포털을 켤 수 있습니다." : "블록체인에서 재개한 뒤 포털을 켤 수 있습니다."}</small>`
        : "";
      return toggle + chain + remove + hint;
    },
    empty: "등록된 게임이 없습니다.",
  });
}
const PAGE_SIZE = 10;
const FAILED_OPERATIONS = "실패";
const ATTENTION_PAYMENTS = "확인 필요";
function activePayments(data: any, now = Date.now()) {
  const trackedOperations = new Map<string, any>();
  for (const op of data.operations) {
    if (["pay", "claimDelivery"].includes(op.kind))
      trackedOperations.set(`${op.kind}:${op.resource_id}`, op);
  }
  // Saigon can take tens of minutes to finalize a payment or delivery claim.
  const reviewAfterMinutes = data.deployment.finality === "local" ? 15 : 60;
  return data.payments
    .filter((p: any) =>
      ["PAID", "DELIVERY_CLAIMED", "PROCESSING"].includes(p.status),
    )
    .map((p: any) => {
      if (p.status === "PAID") {
        const deadline = Number(p.claim_by) * 1000;
        const attention = deadline > 0 && deadline <= now;
        const progress =
          deadline > 0
            ? `지급 시작 기한 ${when(deadline)}`
            : "게임에서 아이템 지급을 준비하고 있습니다.";
        return {
          ...p,
          attention,
          progress,
          next: attention
            ? "게임 서버의 지급 시작 또는 환불 상태를 확인하세요."
            : "",
        };
      }
      const delivery = p.status === "DELIVERY_CLAIMED";
      const op = trackedOperations.get(
        `${delivery ? "claimDelivery" : "pay"}:${p.id}`,
      );
      const submitted = op?.created_at;
      const elapsed = submitted
        ? Math.max(0, Math.floor((now - submitted) / 60_000))
        : undefined;
      const attention = elapsed !== undefined && elapsed >= reviewAfterMinutes;
      return {
        ...p,
        attention,
        progress:
          elapsed === undefined
            ? delivery
              ? "아이템 지급 완료 대기"
              : "블록체인에서 결제 확인 중"
            : `${delivery ? "지급 시작 요청" : "결제 요청"} 후 ${elapsed}분`,
        next: attention
          ? delivery
            ? "게임 서버에서 아이템 지급 결과를 확인하세요."
            : "관련 작업에서 결제 거래 상태를 확인하세요."
          : "",
      };
    });
}
function renderOperations(
  data: any,
  payments: ReturnType<typeof activePayments>,
) {
  const running = (o: any) => !["FINALIZED", "FAILED"].includes(o.status);
  const gameNames = new Map<string, string>(
    data.games.map((game: { id: string; name: string }) => [
      game.id,
      game.name,
    ]),
  );
  const gameCell = (id: string | null) => {
    if (!id) return "네트워크";
    const name = gameNames.get(id);
    return name
      ? `<strong>${esc(name)}</strong><small>${esc(id)}</small>`
      : esc(id);
  };
  renderTable<any>($("#operations"), {
    rows: data.operations,
    key: (o) => o.id,
    pageSize: PAGE_SIZE,
    searchPlaceholder: "작업·게임·결제 ID·오류 검색",
    searchText: (o) =>
      `${o.kind} ${OPERATION_LABELS[o.kind] ?? ""} ${o.game_id ?? ""} ${gameNames.get(o.game_id) ?? ""} ${o.error ?? ""} ${o.id} ${o.resource_id}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "진행 중", match: running },
      { label: FAILED_OPERATIONS, match: byStatus("FAILED") },
      { label: "완료", match: byStatus("FINALIZED") },
    ],
    columns: [
      { label: "시각", cell: (o) => when(o.created_at), className: "nowrap" },
      {
        label: "작업",
        cell: (o) =>
          `<strong>${esc(OPERATION_LABELS[o.kind] ?? o.kind)}</strong>`,
      },
      { label: "게임", cell: (o) => gameCell(o.game_id) },
      {
        label: "상태",
        // An allocation in a block is already spendable; finality only follows.
        cell: (o) =>
          o.kind === "allocate" && o.status === "INCLUDED"
            ? pill("INCLUDED", "반영됨 · 확정 중")
            : pill(o.status),
      },
    ],
    detail: (o) =>
      detailList([
        ["오류", esc(o.error ?? "")],
        ["작업 ID", `<code>${esc(o.id)}</code>`],
        ["대상", `<code>${esc(o.resource_id)}</code>`],
      ]),
    detailLabel: (o) =>
      o.status === "FAILED" ? "오류 상세 보기" : "상세 보기",
    actions: (o) =>
      ["SUBMITTED", "RECONCILING", "PREPARED"].includes(o.status)
        ? `<button type="button" class="small" data-replace="${esc(o.id)}">수수료 대체</button>`
        : "",
    empty: "아직 작업이 없습니다.",
  });
  renderTable<any>($("#stalled-payments"), {
    rows: payments,
    key: (p) => p.id,
    searchPlaceholder: "게임·결제 ID 검색",
    searchText: (p) => `${p.game_id} ${gameNames.get(p.game_id) ?? ""} ${p.id}`,
    filters: [
      { label: "전체", match: () => true },
      { label: ATTENTION_PAYMENTS, match: (p) => p.attention },
      { label: "처리 중", match: (p) => !p.attention },
    ],
    columns: [
      { label: "생성", cell: (p) => when(p.created_at), className: "nowrap" },
      { label: "게임", cell: (p) => gameCell(p.game_id) },
      { label: "결제 ID", cell: (p) => `<code>${esc(p.id)}</code>` },
      {
        label: "상태",
        cell: (p) =>
          `${pill(p.status)}${p.attention ? pill("FAILED", ATTENTION_PAYMENTS) : ""}<small>${esc(p.progress)}</small>${p.next ? `<small>${esc(p.next)}</small>` : ""}`,
      },
    ],
    actions: (p) =>
      `<button type="button" class="small" data-section="operation-panel" data-table-target="operations" data-table-query="${esc(p.id)}">관련 작업 보기</button>${p.status === "DELIVERY_CLAIMED" && p.attention ? `<button type="button" class="small quiet" data-recovery-payment="${esc(p.id)}">복구 준비</button>` : ""}`,
    empty: "진행 중인 결제가 없습니다.",
  });
}
const AUDIT_GROUPS: [string, string[]][] = [
  ["로그인·계정", ["session.", "account.", "admin."]],
  ["운영자 신청", ["operator.application."]],
  ["게임", ["game."]],
  ["예산·발행", ["allocation.", "issuance.", "budget."]],
  ["API 키", ["credential."]],
  ["가스·작업", ["relayer.", "operation."]],
];
const AUDIT_LABELS: Record<string, string> = {
  "session.wallet-login": "지갑 로그인",
  "account.wallet-linked": "수령 지갑 연결",
  "admin.setup-wallet": "관리자 지갑 설정",
  "operator.application.create": "운영자 신청",
  "operator.application.approve": "운영자 승인",
  "operator.application.reject": "운영자 반려",
  "game.registration.submit": "게임 등록 신청",
  "game.registration.approve": "게임 등록 승인",
  "game.registration.reject": "게임 등록 반려",
  "game.register": "게임 체인 기록",
  "game.active": "게임 켜기·끄기",
  "game.chain-state": "체인 중지·재개",
  "game.delete": "게임 삭제",
  "allocation.create": "예산 배분",
  "allocation.schedule.create": "반복 배분 등록",
  "allocation.schedule.update": "반복 배분 중지·재개",
  "allocation.schedule.delete": "반복 배분 삭제",
  "issuance.create": "CGC 발행",
  "budget.reconciled": "예산 장부 보정",
  "credential.issue": "API 키 발급",
  "credential.revoke": "API 키 폐기",
  "relayer.fund": "중계 지갑 충전",
  "operation.replace": "수수료 대체",
  "resolution.approve": "공동 승인 환불",
  "deployment.activate": "배포 활성화",
};
const inAuditGroup = (action: string, prefixes: string[]) =>
  prefixes.some((prefix) => action.startsWith(prefix));
function renderAudit(data: any) {
  const pretty = (payload: string) => {
    try {
      return JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      return payload;
    }
  };
  const grouped = AUDIT_GROUPS.flatMap(([, prefixes]) => prefixes);
  renderTable<any>($("#audit"), {
    rows: data.audit,
    key: (a) => a.id,
    pageSize: PAGE_SIZE,
    searchPlaceholder: "작업·실행자·내용 검색",
    searchText: (a) =>
      `${a.action} ${AUDIT_LABELS[a.action] ?? ""} ${a.actor_id} ${a.payload}`,
    filters: [
      { label: "전체", match: () => true },
      ...AUDIT_GROUPS.map(([label, prefixes]) => ({
        label,
        match: (a: any) => inAuditGroup(a.action, prefixes),
      })),
      { label: "기타", match: (a: any) => !inAuditGroup(a.action, grouped) },
    ],
    columns: [
      { label: "시각", cell: (a) => when(a.created_at), className: "nowrap" },
      {
        label: "작업",
        cell: (a) =>
          `<strong>${esc(AUDIT_LABELS[a.action] ?? a.action)}</strong>`,
      },
      { label: "실행자", cell: (a) => esc(a.actor_id) },
    ],
    detail: (a) =>
      `<p class="muted"><code>${esc(a.action)}</code></p><pre class="audit-payload">${esc(pretty(a.payload))}</pre>`,
    empty: "관리 기록이 없습니다.",
  });
}
async function refreshAdmin() {
  const [data, applications, schedules] = await Promise.all([
      api("/admin/overview"),
      api("/operator-applications"),
      api("/allocation-schedules"),
    ]),
    a = data.accounting;
  const pendingApplications = renderOperatorApplications(
    applications.applications,
  );
  renderRegistrations(data.registrations);
  renderAllocation(data, schedules.schedules);
  const reviewCount =
    pendingApplications +
    data.registrations.filter((r: any) =>
      ["PENDING", "FAILED"].includes(r.status),
    ).length;
  const failedOps = data.operations.filter(
    (o: any) => o.status === "FAILED",
  ).length;
  const runningOps = data.operations.filter(
    (o: any) => !["FINALIZED", "FAILED"].includes(o.status),
  ).length;
  const payments = activePayments(data);
  const stalledCount = payments.filter((p: any) => p.attention).length;
  const todo: [string, string, string, string, string, string?][] = [
    [
      "review",
      "심사 대기 (운영자·게임)",
      `${reviewCount}건`,
      reviewCount ? "승인 또는 반려가 필요합니다" : "대기 중인 신청이 없습니다",
      reviewCount ? "pending" : "ok",
      `data-section="${pendingApplications ? "application-review-panel" : "registration-review-panel"}"`,
    ],
    [
      "ops",
      "실패한 작업",
      `${failedOps}건`,
      runningOps ? `진행 중 ${runningOps}건` : "진행 중인 작업 없음",
      failedOps ? "failed" : "ok",
      `data-section="operation-panel" data-table-target="operations" data-table-filter="${FAILED_OPERATIONS}"`,
    ],
    [
      "ops",
      "확인이 필요한 결제",
      `${stalledCount}건`,
      payments.length
        ? `처리 중 ${payments.length - stalledCount}건`
        : "진행 중인 결제 없음",
      stalledCount ? "pending" : "ok",
      `data-section="payment-attention-panel" data-table-target="stalled-payments"${stalledCount ? ` data-table-filter="${ATTENTION_PAYMENTS}"` : ""}`,
    ],
    [
      "budget",
      "자금 보존",
      a.solvent ? "정상" : "확인 필요",
      `미배분 보유분 ${format(a.reserve)} CGC`,
      a.solvent ? "ok" : "failed",
    ],
  ];
  const priority: Record<string, number> = { failed: 0, pending: 1, ok: 2 };
  todo.sort((a, b) => priority[a[4]] - priority[b[4]]);
  $("#admin-todo").innerHTML = todo
    .map(
      ([tab, label, value, detail, tone, target = ""]) =>
        `<button type="button" class="todo-card ${tone}" data-goto="${tab}" ${target}><span>${label}</span><strong>${value}</strong><small>${detail}</small><span class="todo-arrow" aria-hidden="true">→</span></button>`,
    )
    .join("");
  setTabCount("review", reviewCount);
  setTabCount(
    "ops",
    failedOps + stalledCount,
    failedOps ? "failed" : "pending",
  );
  const gasLow = renderRelayerGas(data.deployment, a, data.relayerFunding);
  setTabCount("overview", gasLow ? 1 : 0, "failed");
  latestOverview = data;
  renderIssuance(data);
  $("#network-stats").innerHTML = [
    ["미배분 보유분", `${format(a.reserve)} CGC`],
    ["게임 예산", `${format(a.budgets)} CGC`],
    ["결제 보관금", `${format(a.escrow)} CGC`],
    ["자금 보존", a.solvent ? "정상" : "확인 필요"],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join("");
  renderOperations(data, payments);
  renderAudit(data);
  renderAdminGames(data);
}
async function mount() {
  if (!token) return;
  me = await api("/me");
  await refreshLoginWallets();
  show("#login-view", false);
  show("#workspace", true);
  show("#logout", true);
  const role = me.role as Role;
  $("#identity").textContent = ROLE_LABELS[role] ?? role;
  $("#workspace-role").textContent = ROLE_LABELS[role] ?? role;
  $("#identity").className = `role-chip role-${role}`;
  document.body.dataset.role = role;
  for (const view of ["player", "operator", "admin"])
    show(`#${view}-view`, view === role);
  show("#wallet-tools", role !== "player");
  $("#approval-wallet-title").textContent =
    role === "operator"
      ? "예치·인출 및 예외 환불에 서명하는 지갑"
      : "환불 공동 승인에 서명하는 지갑";
  show("#resolution-panel", role !== "player");
  $("#resolution-panel").dataset.tab = role === "admin" ? "ops" : "recovery";
  renderNav();
  show(
    "#local-key-label",
    asset.deployments.some((d: any) => d.finality === "local"),
  );
  show(
    "#load-local-key",
    asset.deployments.some((d: any) => d.finality === "local"),
  );
  if (role === "player") await refreshPlayer();
  else if (role === "operator") await refreshOperator();
  else await refreshAdmin();
}
on("#wallet-login", "click", async () => {
  if (authBusy) return;
  authBusy = true;
  const attemptEpoch = sessionEpoch;
  $("#login-feedback").classList.remove("feedback-error");
  $("#login-feedback").textContent =
    "지갑을 선택하고 로그인 메시지를 승인하세요.";
  try {
    await connectWallet(
      "이 지갑으로 로그인합니다. 처음 쓰는 지갑이면 새 이용자로 가입됩니다.",
    );
    $("#login-feedback").textContent =
      "지갑 앱에서 로그인 메시지 서명을 승인하세요.";
    const loginAddress = address!;
    const provider = walletProvider!;
    const chainId = walletChainId!;
    const proof = await signWalletChallenge("/sessions/wallet/challenges");
    const result = await api("/sessions/wallet", proof);
    try {
      await assertWalletSession(provider, loginAddress, chainId);
    } catch (error) {
      await fetch("/v1/sessions/me", {
        method: "DELETE",
        headers: { authorization: `Bearer ${result.token}` },
      }).catch(() => {});
      throw error;
    }
    saveSession(result, loginAddress, attemptEpoch);
    $("#login-feedback").textContent = "로그인에는 가스비가 들지 않습니다.";
    await mount();
    toast("지갑으로 로그인했습니다.");
  } catch (error) {
    $("#login-feedback").textContent = walletErrorMessage(error);
    $("#login-feedback").classList.add("feedback-error");
    if ($("#login-view").classList.contains("hidden")) throw error;
  } finally {
    authBusy = false;
  }
});
on("#admin-setup", "submit", async (e) => {
  e.preventDefault();
  if (authBusy) return;
  authBusy = true;
  const attemptEpoch = sessionEpoch;
  const form = e.currentTarget as HTMLFormElement;
  $("#admin-setup-feedback").classList.remove("feedback-error");
  const setupCode = String(new FormData(form).get("setupCode") ?? "").trim();
  try {
    await connectWallet(
      "이 지갑이 관리자 로그인 지갑이 됩니다. 이후 이 지갑으로 관리자 화면에 로그인합니다.",
    );
    const challenge = await api("/setup/admin-wallet/challenges", {
      address,
      deploymentId: asset.activeDeploymentId,
      setupCode,
    });
    $("#admin-setup-feedback").textContent =
      "지갑 앱에서 메시지 서명을 승인하세요.";
    const provider = await signingProvider();
    const signature = await provider.request({
      method: "personal_sign",
      params: [toHex(challenge.message), address],
    });
    const result = await api("/setup/admin-wallet", {
      challengeId: challenge.challengeId,
      signature,
      setupCode,
    });
    saveSession(result, address, attemptEpoch);
    form.reset();
    show("#admin-setup", false);
    show("#wallet-login-panel", true);
    await mount();
    toast(
      "관리자 로그인 지갑을 연결했습니다. 다음부터 이 지갑으로 로그인하세요.",
    );
  } catch (error) {
    $("#admin-setup-feedback").textContent = walletErrorMessage(error);
    $("#admin-setup-feedback").classList.add("feedback-error");
    if ($("#login-view").classList.contains("hidden")) throw error;
  } finally {
    authBusy = false;
  }
});
on("#link-login-wallet", "click", async () => {
  if (authBusy) return;
  authBusy = true;
  try {
    await connectWallet("이 지갑을 지금 계정의 로그인 지갑으로 등록합니다.");
    const proof = await signWalletChallenge(
      "/account/login-wallets/challenges",
    );
    await api("/account/login-wallets", proof);
    await refreshLoginWallets();
    toast(
      "로그인 지갑을 등록했습니다. 다음부터 이 지갑의 서명으로 로그인할 수 있습니다.",
    );
  } finally {
    authBusy = false;
  }
});
on("#logout", "click", async () => {
  await api("/sessions/me", undefined, "DELETE");
  sessionStorage.removeItem("metanomic-session");
  location.reload();
});
async function resetWalletConnection() {
  const existingProvider = walletProvider;
  const oldToken = token;
  resetSession();
  const logout = oldToken
    ? fetch("/v1/sessions/me", {
        method: "DELETE",
        headers: { authorization: `Bearer ${oldToken}` },
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.ok || r.status === 401)
        .catch(() => false)
    : Promise.resolve(true);
  walletDiscovery.request();
  const wallets = walletDiscovery.wallets();
  let provider =
    existingProvider ??
    (wallets.length === 1 ? wallets[0].provider : undefined);
  if (!provider && wallets.length > 1)
    provider = (await chooseWallet()).provider;
  const [loggedOut, revoked] = await Promise.all([
    logout,
    provider ? revokeWalletConnection(provider) : Promise.resolve(false),
  ]);
  const feedback =
    (revoked
      ? "로그인과 지갑 연결 권한을 초기화했습니다. 지갑 선택하기를 눌러 다시 연결하세요."
      : `이 사이트의 로그인 상태를 초기화했습니다. 지갑 앱의 Settings → Connected dApps에서 ${location.host} 연결을 해제한 뒤 다시 로그인하세요.`) +
    (loggedOut ? "" : " 서버 세션 종료는 확인하지 못했습니다.");
  sessionStorage.setItem("metanomic-wallet-reset-feedback", feedback);
  location.reload();
}
on("#reset-wallet", "click", resetWalletConnection);
on("#reset-account-wallet", "click", resetWalletConnection);
on("#connect-signer", "click", () =>
  connectWallet("이 지갑으로 예치·인출·공동 승인 같은 계약 작업에 서명합니다."),
);
on("#load-local-key", "click", () => {
  if (!asset.deployments.some((d: any) => d.finality === "local"))
    throw new Error("로컬에서만 사용할 수 있습니다.");
  localAccount = privateKeyToAccount(
    $("#local-key") instanceof HTMLInputElement
      ? (($("#local-key") as HTMLInputElement).value as `0x${string}`)
      : "0x",
  );
  walletProvider = undefined;
  walletChainId = undefined;
  address = localAccount.address;
  connectedWalletName = "로컬 테스트 지갑";
  ($("#local-key") as HTMLInputElement).value = "";
  renderSigningWallet();
  toast("로컬 승인 지갑이 연결됐습니다.");
});
const checkoutDialog = $<HTMLDialogElement>("#checkout");
checkoutDialog.addEventListener("cancel", (e) => {
  if ($<HTMLButtonElement>("#authorize-payment").disabled) e.preventDefault();
});
on("#authorize-payment", "click", async () => {
  const feedback = $("#checkout-progress");
  const close = $<HTMLButtonElement>("#checkout .close");
  const epoch = sessionEpoch;
  let operationId: string;
  close.disabled = true;
  feedback.classList.remove("feedback-error");
  try {
    feedback.textContent = "결제 상태를 확인하고 있습니다…";
    const pay = await api(`/payments/${currentPayment.paymentId}`);
    if (pay.status !== "CREATED")
      throw new Error(
        "결제 상태가 바뀌었습니다. 나의 활동에서 최신 상태를 확인하세요.",
      );
    feedback.textContent = "1/2 지갑 앱에서 결제 승인에 서명하세요.";
    const signature = await signTyped(pay.authorization);
    feedback.textContent = "2/2 지갑 앱에서 CGC 사용 승인에 서명하세요.";
    const permitSignature = await signTyped(pay.permit);
    feedback.textContent = "결제를 제출하고 있습니다…";
    const result = await api(`/payments/${pay.paymentId}/authorizations`, {
      signature,
      permitSignature,
      permitDeadline: pay.expiresAt,
    });
    operationId = result.operationId;
  } catch (error) {
    feedback.textContent = walletErrorMessage(error);
    feedback.classList.add("feedback-error");
    return;
  } finally {
    close.disabled = false;
  }
  if (epoch !== sessionEpoch) return;
  checkoutDialog.close();
  toast("결제를 접수했습니다. 아이템 지급까지 진행 상태를 확인할 수 있습니다.");
  await refreshPlayer();
  void waitOperation(operationId, false)
    .then(() => {
      if (epoch === sessionEpoch) return refreshPlayer();
    })
    .catch((error) => {
      if (epoch === sessionEpoch) toast(walletErrorMessage(error), true);
    });
});
function focusPageHeading() {
  const heading = $(`#${me.role}-view .page-heading h1`);
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
on("#workspace-menu", "click", () => {
  setWorkspaceMenu(
    $("#workspace-menu").getAttribute("aria-expanded") !== "true",
  );
});
$(".workspace-sidebar").addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    $("#workspace-menu").getAttribute("aria-expanded") === "true"
  ) {
    setWorkspaceMenu(false);
    $("#workspace-menu").focus();
  }
});
$("#navigation").addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    "[data-nav]",
  );
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  selectTab(link.dataset.nav!, true);
  focusPageHeading();
});
window.addEventListener("hashchange", () => {
  if (!me) return;
  selectTab(location.hash.slice(1));
  focusPageHeading();
});
// Step guides and summary cards point at existing controls instead of duplicating their logic.
$("#workspace").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-reload]")) location.reload();
  const copy = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (copy)
    // Links still open normally; copying is best-effort alongside navigation.
    void navigator.clipboard
      .writeText(copy.dataset.copy!)
      .then(() => toast(`${copy.dataset.copyLabel ?? "주소"}를 복사했습니다.`))
      .catch(() =>
        toast(
          "주소를 복사하지 못했습니다. 주소를 직접 선택해 복사하세요.",
          true,
        ),
      );
  const checkoutButton = (e.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-checkout]",
  );
  if (checkoutButton && !checkoutButton.disabled) {
    checkoutButton.disabled = true;
    void checkout(checkoutButton.dataset.checkout!)
      .catch((error) => toast(walletErrorMessage(error), true))
      .finally(() => {
        checkoutButton.disabled = false;
      });
  }
  const trigger = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-goto], [data-step-click], [data-step-focus], [data-section], [data-recovery-payment]",
  );
  if (!trigger) return;
  const {
    goto,
    section,
    operatorGameTarget,
    tableTarget,
    tableFilter,
    tableQuery,
    recoveryPayment,
    budgetOpen,
  } = trigger.dataset;
  if (goto) selectTab(goto, true);
  if (budgetOpen === "once") selectBudgetView("once", false);
  if (operatorGameTarget) selectOperatorGame(operatorGameTarget);
  if (tableTarget) {
    const table = document.getElementById(tableTarget);
    if (table) setTableView(table, tableFilter ?? "전체", tableQuery);
  }
  if (recoveryPayment) {
    const form = $<HTMLFormElement>("#resolution-form");
    const id = $<HTMLInputElement>("#resolution-form [name=paymentId]");
    if (id.value !== recoveryPayment) form.reset();
    id.value = recoveryPayment;
    revealSection($("#resolution-panel"));
  } else if (section) {
    const panel = document.getElementById(section);
    if (panel) revealSection(panel);
  } else if (
    operatorGameTarget &&
    goto === "integration" &&
    !trigger.dataset.stepFocus
  ) {
    const card = document.querySelector<HTMLElement>(
      `[data-integration-game="${CSS.escape(operatorGameTarget)}"]`,
    );
    if (card) revealSection(card, true);
  } else if (goto && !trigger.dataset.stepFocus) {
    focusPageHeading();
  }
  if (trigger.dataset.stepClick)
    document.querySelector<HTMLElement>(trigger.dataset.stepClick)?.click();
  if (trigger.dataset.stepFocus) {
    const field = document.querySelector<HTMLElement>(
      trigger.dataset.stepFocus,
    );
    if (field) {
      if (field.tabIndex < 0) field.tabIndex = -1;
      field.focus({ preventScroll: true });
      field.scrollIntoView({ block: "center" });
      if (field instanceof HTMLInputElement) field.select();
    }
  }
});
on("#refresh-player", "click", refreshPlayer);
on("#refresh-admin", "click", refreshAdmin);
on("#refresh-operator", "click", refreshOperator);
initAllocation({
  api,
  confirm: showAction,
  toast,
  refresh: () => refreshAdmin(),
  assetId: () => asset.assetId,
});
// Mirrors the server's reserve rule for the preview; the server enforces it exactly.
const TRANSFER_FEE_ESTIMATE_WEI = parseEther("0.001");
function fundingLimits() {
  const a = latestOverview?.accounting;
  const reserve = BigInt(
    latestOverview?.relayerFunding?.auto?.adminMinWei ?? parseEther("0.5"),
  );
  const admin = BigInt(a?.adminGasWei ?? 0);
  const sendable = admin - reserve - TRANSFER_FEE_ESTIMATE_WEI;
  return {
    admin,
    relayer: BigInt(a?.relayerGasWei ?? 0),
    reserve,
    sendable: sendable > 0n ? sendable : 0n,
  };
}
function renderFundingPreview() {
  const { admin, relayer, reserve, sendable } = fundingLimits();
  let amount = 0n;
  try {
    amount = parseEther(
      String($<HTMLInputElement>("#funding-amount").value || "0"),
    );
  } catch {
    amount = 0n;
  }
  $("#funding-preview").innerHTML =
    `<div class="activity-row"><span>관리자 지갑</span><strong>${ron(admin)} → ${ron(admin - amount)} RON</strong></div><div class="activity-row"><span>중계 지갑</span><strong>${ron(relayer)} → ${ron(relayer + amount)} RON</strong></div><p class="muted">관리자 지갑에는 최소 ${ron(reserve)} RON이 남아야 합니다. 지금 보낼 수 있는 최대량은 약 ${ron(sendable)} RON입니다.</p>`;
}
$("#workspace").addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("[data-fund-relayer]")) return;
  $<HTMLInputElement>("#funding-amount").value = "";
  renderFundingPreview();
  $<HTMLDialogElement>("#funding-dialog").showModal();
});
$("#funding-amount").addEventListener("input", renderFundingPreview);
on("#funding-max", "click", () => {
  $<HTMLInputElement>("#funding-amount").value = formatEther(
    fundingLimits().sendable,
  );
  renderFundingPreview();
});
on("#cancel-funding", "click", () =>
  $<HTMLDialogElement>("#funding-dialog").close(),
);
on("#funding-form", "submit", async (e) => {
  e.preventDefault();
  const amount = $<HTMLInputElement>("#funding-amount").value.trim();
  const r = await api("/relayer-fundings", { amount });
  $<HTMLDialogElement>("#funding-dialog").close();
  toast(
    `중계 지갑 충전 ${amount} RON을 접수했습니다. 블록에 포함되면 잔액에 반영됩니다.`,
  );
  await refreshAdmin();
  await waitOperation(r.operationId);
  await refreshAdmin();
});
// Admin list actions are delegated so they keep working after a table redraws.
const REVIEW_TABLES: Record<string, [string, string]> = {
  application: ["#admin-operator-applications", "/operator-applications"],
  registration: ["#admin-registrations", "/game-registrations"],
};
$("#admin-view").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const d = button.dataset;
  const run = (work: () => Promise<unknown>) => {
    button.disabled = true;
    void work()
      .catch((error) => toast(walletErrorMessage(error), true))
      .finally(() => {
        button.disabled = false;
      });
  };
  if (d.approveApplication)
    run(async () => {
      await api(`/operator-applications/${d.approveApplication}/approvals`, {});
      toast("운영자로 전환했습니다. 이제 게임 등록을 신청할 수 있습니다.");
      await refreshAdmin();
    });
  else if (d.rejectOpen) {
    const [kind, id] = d.rejectOpen.split(":");
    openTableRow($(REVIEW_TABLES[kind][0]), id);
    document
      .querySelector<HTMLInputElement>(`[data-reject-input="${d.rejectOpen}"]`)
      ?.focus();
  } else if (d.rejectConfirm) {
    const [kind, id] = d.rejectConfirm.split(":");
    const input = document.querySelector<HTMLInputElement>(
      `[data-reject-input="${d.rejectConfirm}"]`,
    )!;
    const reason = input.value.trim();
    if (!reason) {
      toast("반려 사유를 입력하세요.", true);
      input.focus();
      return;
    }
    run(async () => {
      await api(`${REVIEW_TABLES[kind][1]}/${id}/rejections`, { reason });
      input.value = "";
      toast("반려했습니다. 신청자가 사유를 보고 다시 신청할 수 있습니다.");
      await refreshAdmin();
    });
  } else if (d.approveRegistration)
    run(async () => {
      await api(`/game-registrations/${d.approveRegistration}/approvals`, {});
      toast("승인을 접수했습니다. 계약 등록이 확정되면 이용자에게 공개됩니다.");
      await refreshAdmin();
    });
  else if (d.gameToggle) {
    const turnOn = d.active !== "1";
    const label = turnOn ? "포털에서 켜기" : "포털에서 끄기";
    showAction(
      label,
      detailList([
        ["게임", esc(d.name)],
        [
          "적용",
          turnOn
            ? "즉시 게임 목록에 공개하고 새 결제·보상을 허용합니다."
            : "즉시 목록에서 숨기고 새 결제·보상을 중지합니다. 이미 접수된 지급과 환불은 계속 처리합니다.",
        ],
        [
          "되돌리기",
          turnOn
            ? "[게임] 메뉴에서 포털을 다시 끌 수 있습니다."
            : "[게임] 메뉴에서 포털을 다시 켤 수 있습니다.",
        ],
      ]),
      label,
      async () => {
        await api(`/games/${d.gameToggle}`, { active: turnOn }, "PATCH");
        toast(
          turnOn
            ? "게임을 켰습니다."
            : "게임을 껐습니다. 새 결제와 보상이 막힙니다.",
        );
        void refreshAdmin().catch((error) =>
          toast(walletErrorMessage(error), true),
        );
      },
    );
  } else if (d.chainState) {
    const resume = d.active === "1";
    const label = resume ? "블록체인에서 재개" : "블록체인에서 중지";
    showAction(
      label,
      detailList([
        ["게임", esc(d.name)],
        [
          "적용",
          resume
            ? "확정되면 계약이 재개됩니다. 게임을 공개하려면 이후 포털에서 켜세요."
            : "확정되면 계약이 새 결제·보상·배분을 차단하고 포털에서도 게임을 끕니다.",
        ],
        ["거래", "서버의 관리자 지갑이 거래 1건을 보내고 RON 수수료를 냅니다."],
        [
          "다음 단계",
          resume
            ? "[게임] 메뉴의 블록체인 상태가 재개되면 포털에서 켜세요."
            : "[게임] 메뉴에서 블록체인 상태를 확인하세요. 되돌리려면 재개 거래가 필요합니다.",
        ],
      ]),
      `${resume ? "재개" : "중지"} 거래 요청`,
      async () => {
        await api(`/games/${d.chainState}/chain-state`, { active: resume });
        toast(
          "거래를 접수했습니다. [게임] 메뉴에서 블록체인 상태를 확인하세요.",
        );
        void refreshAdmin().catch((error) =>
          toast(walletErrorMessage(error), true),
        );
      },
    );
  } else if (d.gameDelete) {
    if (
      !confirm(
        `"${d.name}" 게임을 포털에서 삭제할까요?\n\n게임 정보, 자격증명, 이용자 계정 연결이 지워지고 되돌릴 수 없습니다. 결제·보상 기록과 블록체인 장부의 남은 예산은 그대로 남습니다.`,
      )
    )
      return;
    run(async () => {
      await api(`/games/${d.gameDelete}`, undefined, "DELETE");
      toast("게임을 삭제했습니다.");
      await refreshAdmin();
    });
  } else if (d.replace)
    run(async () => {
      await api(`/operations/${d.replace}/replacements`, {});
      toast("같은 업무의 수수료 대체 거래를 준비했습니다.");
      await refreshAdmin();
    });
});
on("#operator-application-form", "submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const fields = Object.fromEntries(new FormData(form));
  // The approval wallet becomes an immutable contract operator address.
  const purpose =
    "이 지갑이 운영자 승인 지갑이 됩니다. 게임을 등록하면 계약에 기록되어 바꿀 수 없습니다.";
  if (!address) await connectWallet(purpose);
  else await confirmWallet(address, purpose, walletProvider);
  const proof = await signWalletChallenge("/operator-applications/challenges");
  await api("/operator-applications", { ...proof, ...fields });
  form.reset();
  toast(
    "운영자 신청을 접수했습니다. 관리자 승인 후 운영자 계정으로 전환됩니다.",
  );
  await refreshPlayer();
});
on("#issuance-form", "input", renderIssuanceFeedback);
on("#issuance-form", "submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const fields = new FormData(form);
  const amount = String(fields.get("amount") ?? "").trim();
  const value = cgcUnits(amount);
  const supply = cgcUnits(latestOverview?.accounting.totalSupply ?? "");
  const cap = cgcUnits(latestOverview?.accounting.supplyCap ?? "");
  if (
    !value ||
    supply === undefined ||
    cap === undefined ||
    supply + value > cap
  )
    return;
  const toOperator = fields.get("target") === "operator";
  const operator = toOperator
    ? latestOverview.accounts.find(
        (entry: any) => entry.id === fields.get("operatorId") && entry.wallet,
      )
    : undefined;
  if (toOperator && !operator) return;

  const issuanceRef = `issue-${randomUUID()}`;
  const request = {
    assetId: asset.assetId,
    amount,
    target: toOperator ? "operator" : "reserve",
    ...(operator ? { operatorId: operator.id } : {}),
    issuanceRef,
  };
  showAction(
    "발행 내용을 확인하세요",
    detailList([
      [
        "받을 곳",
        operator
          ? `운영자 지갑 · ${esc(operator.username)}`
          : "네트워크 보유분",
      ],
      ["지갑 주소", operator ? `<code>${esc(operator.wallet)}</code>` : ""],
      ["발행 수량", `${cgcLabel(value)} CGC`],
      [
        "발행 후 총발행량",
        `${cgcLabel(supply + value)} / ${cgcLabel(cap)} CGC`,
      ],
      [
        "적용",
        operator
          ? "거래가 확정되면 운영자 지갑에 들어갑니다."
          : "거래 3건이 차례로 확정되면 배분 가능한 보유분에 합쳐집니다.",
      ],
      ["확인", "발행한 수량은 되돌릴 수 없습니다."],
    ]),
    "CGC 발행 실행",
    async () => {
      await api("/issuances", request, "POST", issuanceRef);
      (form.elements.namedItem("amount") as HTMLInputElement).value = "";
      renderIssuanceFeedback();
      $("#issuance-records").setAttribute("open", "");
      toast("CGC 발행을 접수했습니다. 발행 기록에서 진행 상태를 확인하세요.");
      void refreshAdmin().catch(() =>
        toast("발행은 접수됐습니다. 새로고침해 기록을 확인하세요."),
      );
    },
  );
});
$("#operator-view").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-cancel-resubmit]")) {
    $<HTMLFormElement>("#game-registration-form").reset();
    show("#registration-resubmit", false);
    return;
  }
  const button = target.closest<HTMLButtonElement>("[data-resubmit]");
  if (!button) return;
  const r = operatorRegistrations.find(
    (x) => x.registrationId === button.dataset.resubmit,
  );
  if (!r) return;
  const form = $<HTMLFormElement>("#game-registration-form");
  for (const name of ["gameId", "name", "category", "description", "playUrl"])
    (form.elements.namedItem(name) as HTMLInputElement).value = r[name] ?? "";
  $("#registration-resubmit").innerHTML =
    `<strong>${esc(r.gameId)}</strong> 다시 신청 중 · 반려 사유: ${esc(r.reviewNote ?? "—")} <button type="button" class="quiet small" data-cancel-resubmit>새 신청으로</button>`;
  show("#registration-resubmit", true);
  form
    .closest(".registration-panel")!
    .scrollIntoView({ behavior: "smooth", block: "start" });
});
on("#game-registration-form", "submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const fields = Object.fromEntries(new FormData(form));
  // The server issues the game ID; only a resubmission names its rejected one.
  if (!fields.gameId) delete fields.gameId;
  const r = await api("/game-registrations", fields);
  $("#registration-feedback").textContent =
    `${r.name} 등록 신청을 접수했습니다 (게임 ID ${r.gameId}).`;
  form.reset();
  show("#registration-resubmit", false);
  await refreshOperator();
  toast(
    "등록 신청을 접수했습니다. 승인과 계약 등록 확정 후 이용자에게 공개됩니다.",
  );
});
on("#register-form", "submit", async (e) => {
  e.preventDefault();
  await api("/games", Object.fromEntries(new FormData(e.currentTarget)));
  toast("게임 등록을 접수했습니다.");
});
on("#resolution-form", "submit", async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const pay = await api(`/payments/${form.paymentId}`);
  const dep = asset.deployments.find((d: any) => d.id === pay.deploymentId);
  const request = {
    domain: {
      name: "Metanomic Settlement",
      version: "1",
      chainId: dep.chainId,
      verifyingContract: dep.settlement,
    },
    types: {
      Resolution: [
        { name: "paymentId", type: "bytes32" },
        { name: "evidenceHash", type: "bytes32" },
        { name: "validUntil", type: "uint256" },
      ],
    },
    primaryType: "Resolution",
    message: {
      paymentId: keccak256(toHex(String(form.paymentId))),
      evidenceHash: form.evidenceHash,
      validUntil: String(form.validUntil),
    },
  };
  const signature = await signTyped(request);
  const result = await api(`/payments/${form.paymentId}/resolutions`, {
    evidenceHash: form.evidenceHash,
    validUntil: Number(form.validUntil),
    signature,
  });
  toast(
    result.status === "AWAITING_APPROVAL"
      ? "공동 승인을 기다리고 있습니다."
      : "공동 승인 환불을 접수했습니다.",
  );
});
async function boot() {
  const [result, setup] = await Promise.all([api("/assets"), api("/setup")]);
  asset = result.assets[0];
  if (!asset) throw new Error("사용 가능한 자산 배포가 없습니다.");
  // A fresh install must bind the admin's own wallet before anyone else signs in.
  show("#admin-setup", setup.adminWalletSetup);
  show("#wallet-login-panel", !setup.adminWalletSetup);
  ($("#wallet-login") as HTMLButtonElement).disabled = false;
  const resetFeedback = sessionStorage.getItem(
    "metanomic-wallet-reset-feedback",
  );
  if (resetFeedback) {
    $("#login-feedback").textContent = resetFeedback;
    sessionStorage.removeItem("metanomic-wallet-reset-feedback");
  } else
    $("#login-feedback").textContent = "로그인에는 가스비가 들지 않습니다.";
  const d = asset?.deployments.find(
    (d: any) => d.id === asset.activeDeploymentId,
  );
  $("#chain-badge").textContent =
    d?.finality === "local" ? "LOCAL TESTNET" : "SAIGON TESTNET";
  if (token) await mount();
}
on("#retry-login-load", "click", () => location.reload());
void boot().catch((e) => {
  if ($("#login-view").classList.contains("hidden")) {
    toast(e.message, true);
    return;
  }
  $("#login-feedback").textContent =
    "서버 연결을 확인하지 못했습니다. 잠시 후 페이지를 다시 불러오세요.";
  $("#login-feedback").classList.add("feedback-error");
  show("#retry-login-load", true);
});
setInterval(() => {
  if (
    !token ||
    !me ||
    refreshBusy ||
    document.hidden ||
    me.role === "operator" ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName ?? "",
    )
  )
    return;
  refreshBusy = true;
  void (
    me.role === "player"
      ? refreshPlayer()
      : me.role === "admin"
        ? refreshAdmin()
        : refreshOperator()
  )
    .catch(() => {})
    .finally(() => {
      refreshBusy = false;
    });
}, 5000);
