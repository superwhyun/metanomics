import {
  WalletAliasCache,
  renderAccountChoices,
  renderLoginWallets,
} from "./wallet-aliases.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther, getAddress, keccak256, parseEther, toHex } from "viem";
import { openTableRow, renderTable } from "./table.js";
import { initAllocation, renderAllocation } from "./allocation.js";
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
    ["play", "게임과 보상"],
    ["account", "지갑·계정"],
    ["apply", "게임 운영자 신청"],
  ],
  operator: [
    ["games", "내 게임 운영"],
    ["register", "게임 등록 신청"],
    ["account", "지갑·결제 복구"],
  ],
  admin: [
    ["overview", "현황"],
    ["review", "등록 심사"],
    ["budget", "예산·발행"],
    ["games", "게임 관리"],
    ["ops", "작업·장애"],
    ["audit", "관리 기록"],
    ["account", "지갑·계정"],
  ],
};
let currentTab = "";
function roleTabs() {
  return ROLE_TABS[(me?.role as Role) ?? "player"] ?? ROLE_TABS.player;
}
// The page heading names the current tab's job instead of a fixed role title.
const TAB_HEADINGS: Record<Role, Record<string, [string, string]>> = {
  player: {
    play: [
      "게임과 보상",
      "게임 계정을 연결하고, 보상으로 받은 공통 코인(CGC)을 다른 게임에서 사용하세요.",
    ],
    account: ["지갑·계정", "보상 받을 지갑과 로그인 지갑을 관리합니다."],
    apply: [
      "게임 운영자 신청",
      "게임을 등록하고 보상 예산을 운영하려면 운영자 승인을 받으세요.",
    ],
  },
  operator: {
    games: ["내 게임 운영", "게임별 보상 예산과 API 연동을 관리합니다."],
    register: [
      "게임 등록 신청",
      "새 게임을 신청하고 심사 현황을 확인합니다. 승인되면 이용자 목록에 공개됩니다.",
    ],
    account: [
      "지갑·결제 복구",
      "승인 지갑과 로그인 지갑을 확인하고, 지급이 멈춘 결제를 복구합니다.",
    ],
  },
  admin: {
    overview: [
      "현황",
      "처리가 필요한 일, 운영 지갑 가스, 네트워크 자금 현황을 확인합니다.",
    ],
    review: [
      "등록 심사",
      "게임 운영자 신청과 게임 등록 신청을 승인하거나 반려합니다.",
    ],
    budget: [
      "예산·발행",
      "게임에 보상 예산을 배분하고, 발행 한도 안에서 CGC를 추가 발행합니다.",
    ],
    games: [
      "게임 관리",
      "게임을 켜고 끄거나, 블록체인에 중지·재개를 기록하거나, 삭제합니다.",
    ],
    ops: [
      "작업·장애",
      "블록체인 거래의 진행·실패와 지연된 결제를 확인하고 처리합니다.",
    ],
    audit: ["관리 기록", "누가 언제 어떤 관리 작업을 했는지 기록합니다."],
    account: [
      "지갑·계정",
      "관리자 로그인 지갑과 계약 서명용 승인 지갑을 관리합니다.",
    ],
  },
};
function selectTab(tab: string) {
  const tabs = roleTabs();
  currentTab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  const role = (me?.role as Role) ?? "player";
  const heading = TAB_HEADINGS[role]?.[currentTab];
  if (heading) {
    $(`#${role}-view .page-heading h1`).textContent = heading[0];
    $(`#${role}-view .page-heading .role-lead`).textContent = heading[1];
  }
  document
    .querySelectorAll<HTMLElement>("#workspace [data-tab]")
    .forEach((el) =>
      el.classList.toggle(
        "tab-hidden",
        !el.dataset.tab!.split(" ").includes(currentTab),
      ),
    );
  document
    .querySelectorAll<HTMLButtonElement>("#navigation [data-nav]")
    .forEach((b) => {
      const selected = b.dataset.nav === currentTab;
      b.classList.toggle("selected", selected);
      b.setAttribute("aria-selected", String(selected));
    });
  if (location.hash !== `#${currentTab}`)
    history.replaceState(null, "", `#${currentTab}`);
}
function renderNav() {
  $("#navigation").innerHTML = roleTabs()
    .map(
      ([id, label]) =>
        `<button type="button" role="tab" data-nav="${id}">${esc(label)}<span class="tab-count hidden" data-count-for="${id}"></span></button>`,
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
interface StepAction {
  label: string;
  goto?: string;
  click?: string;
  focus?: string;
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
  $(listSelector).innerHTML = steps
    .map((s, i) => {
      const state = s.done ? "done" : i === next ? "current" : "upcoming";
      const a = s.action;
      const button =
        state === "current" && a
          ? `<button type="button" class="primary" ${a.goto ? `data-goto="${esc(a.goto)}"` : ""} ${a.click ? `data-step-click="${esc(a.click)}"` : ""} ${a.focus ? `data-step-focus="${esc(a.focus)}"` : ""}>${esc(a.label)} →</button>`
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
  issuance: any,
  latestOverview: any;
let refreshBusy = false;
let operatorRegistrations: any[] = [];
let catalogGames: any[] = [];
const walletDiscovery = new WalletDiscovery(window);
const walletAliases = new WalletAliasCache();
let walletProvider: WalletProvider | undefined;
let walletChainId: number | undefined;
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
  stopWalletEvents?.();
  stopWalletEvents = undefined;
  catalogKey = "";
  show("#login-view", true);
  show("#workspace", false);
  show("#logout", false);
  $("#identity").textContent = "";
  $("#signer-address").textContent = "현재 지갑이 연결되지 않았습니다.";
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
) {
  const response = await fetch(`/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (response.status === 401 && !path.startsWith("/sessions")) resetSession();
  if (!response.ok) throw new Error(result.error?.message ?? "요청 실패");
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
  $("#signer-address").textContent = `승인 지갑: ${wallet.name} · ${address}`;
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
async function linkWallet() {
  if (!address) await connectWallet();
  const challenge = await api("/wallet-links/challenges", {
    address,
    deploymentId: asset.activeDeploymentId,
  });
  const signature = localAccount
    ? await localAccount.signMessage({ message: challenge.message })
    : await (
        await signingProvider()
      ).request({
        method: "personal_sign",
        params: [toHex(challenge.message), address],
      });
  await api("/wallet-links", { challengeId: challenge.challengeId, signature });
  $("#wallet-status").textContent = short(address!);
  await refreshPlayer();
  await refreshLoginWallets();
  toast("지갑이 연결됐습니다.");
}
async function refreshLoginWallets() {
  const epoch = sessionEpoch;
  const result = await api("/account/login-wallets");
  if (epoch !== sessionEpoch || !token) return;
  walletAliases.remember(result.wallets);
  $("#approval-wallet").textContent = result.signingWallet
    ? `등록된 승인 지갑: ${result.signingWallet} · 계약 서명은 이 지갑으로 합니다.`
    : "등록된 승인 지갑이 없습니다.";
  renderLoginWallets(
    $("#login-wallets"),
    result.wallets,
    async (wallet) => {
      if (epoch !== sessionEpoch || !token)
        throw new Error("다시 로그인하세요.");
      const saved = await api("/account/login-wallets/alias", wallet, "PUT");
      if (epoch !== sessionEpoch || !token) return;
      walletAliases.remember([saved]);
      await refreshLoginWallets();
    },
    toast,
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
async function issueLinkCode(gameId: string) {
  const result = await api("/player-links/codes", { gameId });
  const slot = document.querySelector<HTMLElement>(
    `[data-link-slot="${gameId}"]`,
  );
  if (!slot) return;
  const until = new Date(Date.now() + result.expiresIn * 1000);
  slot.innerHTML = `<div class="link-code"><span>연결 코드</span><code>${esc(result.code)}</code><button type="button" class="quiet" data-copy="${esc(result.code)}" data-copy-label="연결 코드">복사</button></div><p class="muted">${until.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}까지 게임의 계정 연결 화면에 입력하세요. 한 번만 사용할 수 있습니다.</p>`;
}
async function waitOperation(operationId: string) {
  for (let i = 0; i < 100; i++) {
    const op = await api(`/operations/${operationId}`);
    if (op.status === "FINALIZED") return op;
    if (op.status === "FAILED") throw new Error(op.error ?? "작업 실패");
    await new Promise((r) => setTimeout(r, 1000));
  }
  toast("작업을 계속 확인하고 있습니다. 활동 내역에서 진행 상태를 확인하세요.");
}

async function refreshPlayer() {
  const [balances, activity, catalog, applications] = await Promise.all([
    api("/players/me/balances"),
    api("/players/me/activity"),
    api("/games"),
    api("/operator-applications"),
  ]);
  catalogGames = catalog.games;
  const linked = new Set<string>(activity.links.map((l: any) => l.gameId));
  renderCatalog(catalog.games, linked);
  renderOperatorApplication(applications.applications[0]);
  const current = balances.balances.find(
    (b: any) => b.deploymentId === asset.activeDeploymentId,
  );
  $("#balance").textContent = current?.amount ? format(current.amount) : "0";
  if (current?.address)
    $("#wallet-status").textContent = `${short(current.address)} · 지갑 연결됨`;
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
  document
    .querySelectorAll<HTMLButtonElement>("[data-checkout]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          void checkout(b.dataset.checkout!).catch((e) =>
            toast(e.message, true),
          )),
    );
  document.querySelectorAll<HTMLButtonElement>("[data-refund]").forEach(
    (b) =>
      (b.onclick = () =>
        void api(`/payments/${b.dataset.refund}/refunds`, {})
          .then(() => toast("환불을 접수했습니다."))
          .catch((e) => toast(e.message, true))),
  );
  updatePlayerGuide({
    walletAddress: current?.address,
    games: catalog.games,
    linked,
    payments: activity.payments,
    rewards: activity.rewards,
  });
}
const PURCHASED = ["PAID", "DELIVERY_CLAIMED", "COMPLETED"];
function updatePlayerGuide(state: {
  walletAddress?: string;
  games: any[];
  linked: Set<string>;
  payments: any[];
  rewards: any[];
}) {
  const unlinked = state.games.filter((g) => !state.linked.has(g.id));
  const playable = state.games.find((g) => state.linked.has(g.id) && g.playUrl);
  const purchased = state.payments.some((p) => PURCHASED.includes(p.status));
  const waitingPayment = state.payments.find((p) => p.status === "CREATED");
  const launch = playable
    ? {
        label: `${playable.name} 열기`,
        click: `[data-launch="${playable.id}"]`,
      }
    : undefined;
  const steps: Step[] = [
    {
      title: "보상 받을 지갑 연결",
      detail: "Ronin Wallet 등 지갑을 연결하면 코인이 이 지갑으로 들어옵니다.",
      done: !!state.walletAddress,
      action: { label: "지갑 연결", click: "#connect-wallet" },
    },
    {
      title: "게임 계정 연결",
      detail: state.games.length
        ? `${state.games.length}개 게임 중 ${state.linked.size}개 연결됨 · 카드에서 연결 코드를 받아 게임의 계정 연결 화면에 입력하세요.`
        : "아직 참여할 수 있는 게임이 없습니다. 게임이 등록되면 이곳에 표시됩니다.",
      done: state.linked.size > 0,
      action: unlinked.length
        ? {
            label: "연결 코드 받기",
            click: `[data-link-code="${unlinked[0].id}"]`,
          }
        : undefined,
    },
    {
      title: "게임에서 코인 얻기",
      detail:
        "연결한 게임의 보상 조건(랭킹, 미션 등)을 달성하면 공통 코인이 지급됩니다.",
      done: state.rewards.length > 0,
      action: launch,
    },
    {
      title: "공통 코인으로 구매",
      detail: waitingPayment
        ? "결제 승인을 기다리는 주문이 있습니다."
        : "게임 안에서 공통 코인 결제를 선택하면 이곳에서 지갑으로 승인합니다.",
      done: purchased,
      action: waitingPayment
        ? {
            label: "결제 이어하기",
            click: `[data-checkout="${waitingPayment.id}"]`,
          }
        : launch,
    },
  ];
  renderSteps("#player-steps", "#player-steps-progress", steps);
  setTabCount("play", waitingPayment ? 1 : 0);
}
function renderCatalog(games: any[], linked: Set<string>) {
  const next = JSON.stringify([games, [...linked]]);
  if (next === catalogKey) return;
  catalogKey = next;
  $("#catalog-count").textContent = String(games.length).padStart(2, "0");
  $("#game-catalog").innerHTML =
    games
      .map((g, index) => {
        const color = index % 2 ? "b" : "a";
        const isLinked = linked.has(g.id);
        const launch = g.playUrl
          ? `<a class="${isLinked ? "primary" : ""} catalog-launch" href="${esc(g.playUrl)}" target="_blank" rel="noopener noreferrer" data-launch="${esc(g.id)}" aria-label="${esc(g.name)} 게임 실행">게임 실행 ↗</a>`
          : '<span class="muted">게임 실행 주소 준비 중</span>';
        const link = isLinked
          ? '<span class="pill">✓ 계정 연결됨</span>'
          : `<button type="button" class="primary" data-link-code="${esc(g.id)}">연결 코드 받기</button>`;
        return `<article class="game-card game-${color}"><div class="game-art"><div class="planet planet-${color}"></div><div class="${color === "a" ? "art-grid" : "harbor-lines"}"></div><span class="genre">${esc(g.category)}</span><span class="game-monogram" aria-hidden="true">${esc(Array.from(String(g.name))[0] ?? "")}</span></div><div class="game-content"><div class="card-tags"><span class="eyebrow">${esc(g.id)}</span></div><h2>${esc(g.name)}</h2><p>${esc(g.description || "새로운 게임을 만나보세요.")}</p><div class="game-status">${esc(g.playUrl ? new URL(g.playUrl).host : "등록된 게임")}</div><div class="actions">${link}${launch}</div><div data-link-slot="${esc(g.id)}"></div></div></article>`;
      })
      .join("") ||
    '<div class="panel empty-state"><h2>아직 참여할 수 있는 게임이 없습니다</h2><p class="muted">게임 운영자가 게임을 등록하고 관리자 승인이 끝나면 이곳에 표시됩니다.</p></div>';
  document
    .querySelectorAll<HTMLButtonElement>("[data-link-code]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          void issueLinkCode(b.dataset.linkCode!).catch((e) =>
            toast(e.message, true),
          )),
    );
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
    ? `서명할 지갑 ${short(address)} · 이 지갑이 운영자 승인 지갑이 됩니다.`
    : "신청할 때 사용할 지갑을 선택합니다. 이 지갑이 운영자 승인 지갑이 됩니다.";
  setTabCount("apply", approved ? 1 : 0);
}
async function checkout(paymentId: string) {
  currentPayment = await api(`/payments/${paymentId}`);
  $("#checkout-details").innerHTML =
    `<p>${esc(gameName(currentPayment.gameId))}</p><h2>${esc(currentPayment.item.name)}</h2><div class="activity-row"><span>수량 ${esc(currentPayment.item.quantity)}</span><strong>${esc(format(currentPayment.amount))} CGC</strong></div>`;
  $("#authorize-payment").textContent =
    `${format(currentPayment.amount)} CGC 결제 승인`;
  ($("#checkout") as HTMLDialogElement).showModal();
}
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
                  ? "승인됐습니다. 내 게임 운영에서 관리하세요."
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
      const [actions, payments, rewards, credentials] = await Promise.all([
        api(`/games/${game.id}/budget-actions`),
        api(`/games/${game.id}/payments`),
        api(`/games/${game.id}/rewards`),
        api(`/games/${game.id}/credentials`),
      ]);
      return {
        game,
        budget: undefined as any,
        actions: actions.actions,
        payments: payments.payments,
        rewards: rewards.rewards,
        credentials: credentials.credentials,
      };
    }),
  );
  renderOperatorOverview(submitted.registrations, views);
  $("#operator-games").innerHTML =
    views
      .map(({ game, actions, payments, rewards, credentials }) => {
        const liveCredentials = credentials.filter((c: any) => !c.revoked);
        return `<article class="panel operator-game"><header class="operator-game-head"><div><span class="eyebrow">${esc(game.id)}</span><h2>${esc(game.name)}</h2></div>${pill(game.active ? "ACTIVE" : "INACTIVE")}</header><div class="mini-stats"><div><strong class="loading" data-budget-available="${esc(game.id)}">확인 중</strong><span>사용 가능 예산 CGC</span></div><div><strong class="loading" data-budget-reserved="${esc(game.id)}">확인 중</strong><span>지급·인출 대기</span></div><div><strong class="${payments.length ? "warn" : ""}">${payments.length}</strong><span>미완료 결제</span></div></div><div class="operator-game-body"><section class="op-block"><h3><span class="op-num">1</span>보상 예산</h3><p class="muted">이용자 보상은 이 예산에서 지급됩니다. 예치·인출은 승인 지갑으로 서명합니다.</p><form class="operator-form" data-budget-form="${esc(game.id)}"><label>금액 (CGC)<input name="amount" value="1.000000" required></label><label>작업<select name="kind"><option value="deposits">추가 예치</option><option value="withdrawals">예산 인출</option></select></label><button type="submit" class="primary">지갑으로 승인</button></form></section><section class="op-block"><h3><span class="op-num">2</span>API 연동 ${liveCredentials.length ? `<span class="pill">사용 중 ${liveCredentials.length}</span>` : '<span class="pill pending">미발급</span>'}</h3><p class="muted">게임 서버가 계정 연결·보상·결제를 요청할 때 사용하는 자격증명입니다.</p><p class="doc-links"><a href="${INTEGRATION_GUIDE_URL}" target="_blank" rel="noopener">연동 가이드 ↗</a><a href="/docs" target="_blank" rel="noopener">API 레퍼런스 ↗</a></p><button data-credential="${esc(game.id)}" class="${liveCredentials.length ? "" : "primary"}">API 자격증명 발급 ↗</button><div id="credential-${esc(game.id)}"></div>${credentials.map((c: any) => `<div class="activity-row"><div><strong>${esc(c.label || "이름 없음")}</strong><small>${c.createdAt ? `${day(c.createdAt)} 발급 · ` : ""}${esc(c.scopes.join(", "))}</small></div><button data-revoke-existing="${esc(c.id)}" data-game="${esc(game.id)}" class="quiet">폐기</button></div>`).join("")}</section></div><details class="op-history"${payments.length ? " open" : ""}><summary>최근 내역 · 미완료 결제 ${payments.length}건</summary><div class="op-history-grid"><div><h3>미완료 결제</h3>${payments.map((p: any) => `<div class="activity-row"><div><strong>${esc(p.item.name)}</strong><small>${esc(p.paymentId)}</small></div>${pill(p.status)}</div>`).join("") || '<p class="muted">미완료 결제가 없습니다.</p>'}</div><div><h3>보상 지급 결과</h3>${
          rewards
            .slice(0, 5)
            .map(
              (r: any) =>
                `<div class="activity-row"><div><strong>${esc(format(r.amount))} CGC</strong><small>${esc(r.rewardRef)}</small></div>${pill(r.status)}</div>`,
            )
            .join("") || '<p class="muted">아직 보상이 없습니다.</p>'
        }</div><div><h3>예치·인출</h3>${
          actions
            .slice(0, 5)
            .map(
              (a: any) =>
                `<div class="activity-row"><span>${a.kind === "deposits" ? "예치" : "인출"} ${format(a.payload.amount)} CGC</span>${pill(a.status)}</div>`,
            )
            .join("") || '<p class="muted">아직 내역이 없습니다.</p>'
        }</div></div></details></article>`;
      })
      .join("") ||
    '<div class="panel empty-state"><h2>아직 운영 중인 게임이 없습니다</h2><p class="muted">게임 등록을 신청하고 관리자 승인이 끝나면 이곳에서 예산과 API 연동을 관리할 수 있습니다.</p><button type="button" class="primary" data-goto="register">게임 등록 신청하기 →</button></div>';
  document
    .querySelectorAll<HTMLButtonElement>("[data-revoke-existing]")
    .forEach(
      (button) =>
        (button.onclick = () => {
          // Revocation deletes the key, so the first click only asks again.
          if (!button.dataset.armed) {
            button.dataset.armed = "1";
            button.textContent = "정말 폐기";
            button.classList.add("danger");
            return;
          }
          void api(
            `/games/${button.dataset.game}/credentials/${button.dataset.revokeExisting}`,
            undefined,
            "DELETE",
          )
            .then(() => refreshOperator())
            .catch((e) => toast(e.message, true));
        }),
    );
  document.querySelectorAll<HTMLFormElement>("[data-budget-form]").forEach(
    (form) =>
      (form.onsubmit = (e) => {
        e.preventDefault();
        void budgetAction(form).catch((e) => toast(e.message, true));
      }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-credential]").forEach(
    (button) =>
      (button.onclick = () => {
        const gameId = button.dataset.credential!;
        const root = $(`#credential-${gameId}`);
        root.innerHTML = `<form class="credential-form"><label>키 이름<input name="label" maxlength="60" required placeholder="예: 운영 서버, 스테이징, 테스트용"></label><button type="submit" class="primary">발급</button><button type="button" class="quiet" data-cancel>취소</button></form>`;
        const form = root.querySelector("form")!;
        form.querySelector<HTMLInputElement>("input")!.focus();
        form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick =
          () => {
            root.innerHTML = "";
          };
        form.onsubmit = (e) => {
          e.preventDefault();
          const label = new FormData(form).get("label")!.toString().trim();
          if (!label) return toast("키 이름을 입력하세요.", true);
          void api(`/games/${gameId}/credentials`, {
            label,
            scopes: ["links", "rewards", "payments", "events", "budget"],
          })
            .then((r) => showIssuedCredential(root, gameId, r))
            .catch((e) => toast(e.message, true));
        };
      }),
  );
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
  renderOperatorOverview(
    submitted.registrations,
    views.map((v) => ({ ...v, budget: byGame.get(v.game.id) })),
  );
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
        : "게임 ID·이름·실행 주소·소개를 입력해 신청합니다.",
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
      title: "API 자격증명 발급",
      detail:
        "게임 서버에 넣을 자격증명을 발급해 계정 연결·보상·결제를 연동합니다.",
      done: hasCredential,
      action: first
        ? {
            label: "자격증명 발급",
            click: `[data-credential="${first.game.id}"]`,
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
async function budgetAction(form: HTMLFormElement) {
  const data = Object.fromEntries(new FormData(form)),
    gameId = form.dataset.budgetForm!,
    kind = String(data.kind);
  const prepared = await api(`/games/${gameId}/${kind}`, {
    assetId: asset.assetId,
    amount: data.amount,
  });
  const signature = await signTyped(prepared.signingRequest);
  let permitSignature, permitDeadline;
  if (kind === "deposits") {
    const list = await api(`/games/${gameId}/budget-actions`);
    const action = list.actions.find((a: any) => a.id === prepared.actionId);
    permitSignature = await signTyped(action.permit);
    permitDeadline = action.expires_at;
  }
  const result = await api(
    `/games/${gameId}/${kind}/${prepared.actionId}/authorizations`,
    { signature, permitSignature, permitDeadline },
  );
  toast("예산 변경을 접수했습니다.");
  await waitOperation(result.operationId);
  await refreshOperator();
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
// The secret is only returned once; the list afterwards shows the label alone.
function showIssuedCredential(root: HTMLElement, gameId: string, r: any) {
  root.innerHTML = `<p class="muted"><strong>${esc(r.label)}</strong> 자격증명입니다. 한 번만 표시되니 게임 서버에 보관하세요.</p><pre class="credential-output"></pre><button data-revoke="${esc(r.credentialId)}">이 자격증명 폐기</button>`;
  root.querySelector("pre")!.textContent = r.token;
  root.querySelector("button")!.onclick = () =>
    void api(
      `/games/${gameId}/credentials/${r.credentialId}`,
      undefined,
      "DELETE",
    ).then(() => {
      root.textContent = "자격증명이 폐기됐습니다.";
    });
}
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
    : `<a class="text-link" href="${EXPLORER_URL}/address/${address}" target="_blank" rel="noopener noreferrer">거래 내역 보기 ↗</a>`;
  const faucet = local
    ? ""
    : `<a class="${low ? "primary" : ""} button-link" href="${FAUCET_URL}" target="_blank" rel="noopener noreferrer" data-copy="${address}">주소 복사하고 Faucet 열기 ↗</a>`;
  return {
    low,
    html: `<article class="panel gas-panel${low ? " low" : ""}"><div class="gas-balance"><span>${esc(wallet.label)} 잔액</span><strong>${ron} RON</strong><small>${low ? esc(wallet.lowNote) : esc(wallet.hint(balance))}</small></div><div class="gas-address"><span>${esc(wallet.label)} 주소</span><code>${address}</code><div class="actions"><button type="button" class="quiet" data-copy="${address}">주소 복사</button>${explorer}</div></div><div class="gas-actions"><p class="muted">Faucet에서 위 주소를 붙여넣고 CAPTCHA를 풀면 하루 1회 5 RON을 받습니다.</p><div class="actions">${extra}${faucet}</div></div></article>`,
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
      lowNote: "0.5 RON 미만입니다. 바닥나면 보상·결제 거래가 멈춥니다.",
      hint: (b) =>
        `보상 약 ${(b / REWARD_GAS_WEI).toLocaleString("ko-KR")}건 또는 구매 약 ${(b / PURCHASE_GAS_WEI).toLocaleString("ko-KR")}건 분량 (추정)`,
    },
    local,
    '<button type="button" data-fund-relayer>관리자 지갑에서 충전</button>',
  );
  const admin = gasRow(
    {
      label: "관리자 지갑",
      address: deployment.admin,
      balanceWei: accounting.adminGasWei,
      lowWei: ADMIN_GAS_LOW_WEI,
      lowNote: "0.1 RON 미만입니다. 바닥나면 예산 배분·발행이 멈춥니다.",
      hint: () => "예산 배분·게임 등록·CGC 발행 거래에 사용합니다.",
    },
    local,
  );
  const auto = funding.auto
    ? `자동 충전 켜짐: 중계 지갑이 ${ron(funding.auto.minWei)} RON 미만이면 관리자 지갑에서 ${ron(funding.auto.topupWei)} RON을 보냅니다. 관리자 지갑에는 ${ron(funding.auto.adminMinWei)} RON을 남깁니다.`
    : "자동 충전 꺼짐 (RELAYER_AUTO_FUND=0). 필요하면 [관리자 지갑에서 충전]으로 보내세요.";
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
  const supply = Number(a.totalSupply),
    cap = Number(a.supplyCap);
  const percent = cap ? Math.min(100, (supply / cap) * 100) : 0;
  $("#supply-meter").innerHTML =
    `<div class="supply-numbers"><span>총발행량 <strong>${format(a.totalSupply)}</strong> / 한도 ${format(a.supplyCap)} CGC</span><span>추가 발행 가능 <strong>${format(String(cap - supply))}</strong> CGC</span></div><div class="supply-bar" role="meter" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${supply}" aria-label="발행 한도 사용률"><span style="width:${percent.toFixed(2)}%"></span></div>`;
  const operators = data.accounts.filter((o: any) => o.wallet);
  const select = $<HTMLSelectElement>("#issuance-operator");
  const options = operators
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
      const toggle = `<button type="button" class="small" data-game-toggle="${esc(g.id)}" data-active="${g.active ? "1" : "0"}"${!g.active && !g.chainActive ? ' disabled title="계약에서 중지된 게임입니다. [체인 재개]가 확정된 뒤 켤 수 있습니다."' : ""}>${g.active ? "끄기" : "켜기"}</button>`;
      const chain = g.chainPending
        ? ""
        : `<button type="button" class="small quiet" data-chain-state="${esc(g.id)}" data-active="${g.chainActive ? "0" : "1"}" data-name="${esc(g.name)}">${g.chainActive ? "체인 중지" : "체인 재개"}</button>`;
      const remove = g.active
        ? ""
        : `<button type="button" class="small danger" data-game-delete="${esc(g.id)}" data-name="${esc(g.name)}">삭제</button>`;
      return toggle + chain + remove;
    },
    empty: "등록된 게임이 없습니다.",
  });
}
const PAGE_SIZE = 10;
function renderOperations(data: any) {
  const running = (o: any) => !["FINALIZED", "FAILED"].includes(o.status);
  renderTable<any>($("#operations"), {
    rows: data.operations,
    key: (o) => o.id,
    pageSize: PAGE_SIZE,
    searchPlaceholder: "작업·게임·오류 검색",
    searchText: (o) =>
      `${o.kind} ${OPERATION_LABELS[o.kind] ?? ""} ${o.game_id ?? ""} ${o.error ?? ""} ${o.id}`,
    filters: [
      { label: "전체", match: () => true },
      { label: "진행 중", match: running },
      { label: "실패", match: byStatus("FAILED") },
      { label: "완료", match: byStatus("FINALIZED") },
    ],
    columns: [
      { label: "시각", cell: (o) => when(o.created_at), className: "nowrap" },
      {
        label: "작업",
        cell: (o) =>
          `<strong>${esc(OPERATION_LABELS[o.kind] ?? o.kind)}</strong>`,
      },
      { label: "게임", cell: (o) => esc(o.game_id ?? "네트워크") },
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
    actions: (o) =>
      ["SUBMITTED", "RECONCILING", "PREPARED"].includes(o.status)
        ? `<button type="button" class="small" data-replace="${esc(o.id)}">수수료 대체</button>`
        : "",
    empty: "아직 작업이 없습니다.",
  });
  renderTable<any>($("#stalled-payments"), {
    rows: data.payments.filter((p: any) =>
      ["PAID", "DELIVERY_CLAIMED", "PROCESSING"].includes(p.status),
    ),
    key: (p) => p.id,
    searchPlaceholder: "게임·결제 ID 검색",
    searchText: (p) => `${p.game_id} ${p.id}`,
    columns: [
      { label: "생성", cell: (p) => when(p.created_at), className: "nowrap" },
      { label: "게임", cell: (p) => esc(p.game_id) },
      { label: "결제 ID", cell: (p) => `<code>${esc(p.id)}</code>` },
      { label: "상태", cell: (p) => pill(p.status) },
    ],
    empty: "지연된 결제가 없습니다.",
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
  const stalledCount = data.payments.filter((p: any) =>
    ["PAID", "DELIVERY_CLAIMED", "PROCESSING"].includes(p.status),
  ).length;
  const todo: [string, string, string, string, string][] = [
    [
      "review",
      "심사 대기 (운영자·게임)",
      `${reviewCount}건`,
      reviewCount ? "승인 또는 반려가 필요합니다" : "대기 중인 신청이 없습니다",
      reviewCount ? "pending" : "ok",
    ],
    [
      "ops",
      "실패한 작업",
      `${failedOps}건`,
      runningOps ? `진행 중 ${runningOps}건` : "진행 중인 작업 없음",
      failedOps ? "failed" : "ok",
    ],
    [
      "ops",
      "지연된 결제",
      `${stalledCount}건`,
      stalledCount ? "아이템 지급 확인이 필요합니다" : "지연 결제 없음",
      stalledCount ? "pending" : "ok",
    ],
    [
      "budget",
      "자금 보존",
      a.solvent ? "정상" : "확인 필요",
      `미배분 보유분 ${format(a.reserve)} CGC`,
      a.solvent ? "ok" : "failed",
    ],
  ];
  $("#admin-todo").innerHTML = todo
    .map(
      ([tab, label, value, detail, tone]) =>
        `<button type="button" class="todo-card ${tone}" data-goto="${tab}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></button>`,
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
    .map(
      ([label, value]) =>
        `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  renderOperations(data);
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
  $("#identity").className = `role-chip role-${role}`;
  document.body.dataset.role = role;
  for (const view of ["player", "operator", "admin"])
    show(`#${view}-view`, view === role);
  show("#wallet-tools", role !== "player");
  show("#resolution-panel", role !== "player");
  // Operators have no ops tab; their payment recovery lives with the signer wallet.
  $("#resolution-panel").dataset.tab = role === "admin" ? "ops" : "account";
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
    throw error;
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
    throw error;
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
      ? "로그인과 지갑 연결 권한을 초기화했습니다. 지갑으로 로그인을 눌러 처음부터 다시 연결하세요."
      : "이 사이트의 로그인 상태를 초기화했습니다. 지갑 앱의 Settings → Connected dApps에서 localhost 연결을 해제한 뒤 다시 로그인하세요.") +
    (loggedOut ? "" : " 서버 세션 종료는 확인하지 못했습니다.");
  sessionStorage.setItem("metanomic-wallet-reset-feedback", feedback);
  location.reload();
}
on("#reset-wallet", "click", resetWalletConnection);
on("#reset-account-wallet", "click", resetWalletConnection);
on("#connect-wallet", "click", async () => {
  await connectWallet("이 지갑으로 공통 코인 보상을 받습니다.");
  await linkWallet();
});
on("#create-wallet", "click", async () => {
  if (!asset.deployments.some((d: any) => d.finality === "local"))
    throw new Error("로컬에서만 사용할 수 있습니다.");
  localAccount = privateKeyToAccount(generatePrivateKey());
  walletProvider = undefined;
  walletChainId = undefined;
  address = localAccount.address;
  await linkWallet();
  toast(
    "브라우저 메모리에 테스트 지갑을 만들었습니다. 새로고침하면 이 키는 사라집니다.",
  );
});
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
  ($("#local-key") as HTMLInputElement).value = "";
  $("#signer-address").textContent = `승인 지갑: ${address}`;
  toast("로컬 승인 지갑이 연결됐습니다.");
});
on("#authorize-payment", "click", async () => {
  const pay = await api(`/payments/${currentPayment.paymentId}`);
  const signature = await signTyped(pay.authorization);
  const permitSignature = await signTyped(pay.permit);
  const r = await api(`/payments/${pay.paymentId}/authorizations`, {
    signature,
    permitSignature,
    permitDeadline: pay.expiresAt,
  });
  ($("#checkout") as HTMLDialogElement).close();
  toast("결제를 접수했습니다. 아이템 지급까지 진행 상태를 확인할 수 있습니다.");
  await waitOperation(r.operationId);
  await refreshPlayer();
});
$("#navigation").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-nav]");
  if (tab) selectTab(tab.dataset.nav!);
});
window.addEventListener("hashchange", () => {
  if (me) selectTab(location.hash.slice(1));
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
  const trigger = (e.target as HTMLElement).closest<HTMLElement>(
    "[data-goto], [data-step-click], [data-step-focus]",
  );
  if (!trigger) return;
  if (trigger.dataset.goto) {
    selectTab(trigger.dataset.goto);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (trigger.dataset.stepClick)
    document.querySelector<HTMLElement>(trigger.dataset.stepClick)?.click();
  if (trigger.dataset.stepFocus) {
    const field = document.querySelector<HTMLInputElement>(
      trigger.dataset.stepFocus,
    );
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus();
    field?.select();
  }
});
on("#refresh-player", "click", refreshPlayer);
on("#refresh-admin", "click", refreshAdmin);
on("#refresh-operator", "click", refreshOperator);
initAllocation({
  api,
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
    run(async () => {
      await api(`/games/${d.gameToggle}`, { active: turnOn }, "PATCH");
      toast(
        turnOn
          ? "게임을 켰습니다."
          : "게임을 껐습니다. 새 결제와 보상이 막힙니다.",
      );
      await refreshAdmin();
    });
  } else if (d.chainState) {
    const resume = d.active === "1";
    if (
      !confirm(
        resume
          ? `"${d.name}"의 재개를 블록체인 계약에 기록할까요?\n\n관리자 지갑이 거래 1건(약 0.002 RON)을 보냅니다. 포털 상태는 바뀌지 않으니 확정 후 [켜기]로 켜세요.`
          : `"${d.name}"의 중지를 블록체인 계약에 기록할까요?\n\n확정되면 서버와 관계없이 계약이 새 결제·보상·배분을 거부하고, 포털도 꺼집니다. 되돌리려면 재개 기록 거래가 필요합니다. 관리자 지갑이 거래 1건(약 0.002 RON)을 보냅니다.`,
      )
    )
      return;
    run(async () => {
      await api(`/games/${d.chainState}/chain-state`, { active: resume });
      toast("블록체인 기록을 접수했습니다. 확정되면 상태가 바뀝니다.");
      await refreshAdmin();
    });
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
on("#issuance-target", "change", () => {
  show(
    "#issuance-operator-label",
    $<HTMLSelectElement>("#issuance-target").value === "operator",
  );
});
on("#issuance-form", "submit", (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.currentTarget));
  const toOperator = form.target === "operator";
  if (toOperator && !form.operatorId)
    throw new Error("지갑이 등록된 운영자가 없습니다.");
  // One reference per preview, so a double-confirmed dialog cannot mint twice.
  issuance = {
    assetId: asset.assetId,
    amount: String(form.amount),
    target: form.target,
    ...(toOperator ? { operatorId: form.operatorId } : {}),
    issuanceRef: `issue-${crypto.randomUUID()}`,
  };
  const a = latestOverview?.accounting;
  const target = toOperator
    ? `운영자 지갑 · ${$<HTMLSelectElement>("#issuance-operator").selectedOptions[0]?.textContent ?? ""}`
    : "네트워크 보유분";
  const after = a
    ? `${format(String(Number(a.totalSupply) + Number(issuance.amount)))} / ${format(a.supplyCap)} CGC`
    : "—";
  $("#issuance-details").innerHTML =
    `<div class="activity-row"><span>대상</span><strong>${esc(target)}</strong></div><div class="activity-row"><span>발행 수량</span><strong>${esc(issuance.amount)} CGC</strong></div><div class="activity-row"><span>발행 후 총발행량</span><strong>${esc(after)}</strong></div><div class="activity-row"><span>거래</span><strong>${toOperator ? "발행 1건" : "발행 → 충전 승인 → 보유분 입금 3건"}</strong></div>`;
  $<HTMLDialogElement>("#issuance-dialog").showModal();
});
on("#cancel-issuance", "click", () =>
  $<HTMLDialogElement>("#issuance-dialog").close(),
);
on("#confirm-issuance", "click", async () => {
  const r = await api("/issuances", issuance);
  $<HTMLDialogElement>("#issuance-dialog").close();
  toast(
    issuance.target === "reserve"
      ? "발행을 접수했습니다. 보유분 입금까지 거래 3건이 차례로 확정됩니다."
      : "발행을 접수했습니다. 확정되면 운영자 지갑에 CGC가 들어갑니다.",
  );
  await refreshAdmin();
  await waitOperation(r.operationId);
  await refreshAdmin();
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
  }
  const d = asset?.deployments.find(
    (d: any) => d.id === asset.activeDeploymentId,
  );
  $("#chain-badge").textContent =
    d?.finality === "local" ? "LOCAL TESTNET" : "SAIGON TESTNET";
  show("#create-wallet", d?.finality === "local");
  if (token) await mount();
}
void boot().catch((e) => {
  toast(e.message, true);
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
