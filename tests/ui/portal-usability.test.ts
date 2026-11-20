import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, type Route } from "playwright";
import { expect } from "playwright/test";

const origin = "http://metanomic.test";
const wallet = `0x${"12".repeat(20)}`;
const deployment = {
  id: "portal-test",
  chainId: 202601,
  finality: "finalized",
  admin: wallet,
  relayer: wallet,
};

async function mobilePage(t: TestContext, role?: "admin" | "player") {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  const responses = new Map<string, (route: Route) => Promise<void>>();
  const respond = (path: string, json: unknown, status = 200) =>
    responses.set(`/v1${path}`, (route) => route.fulfill({ status, json }));
  respond("/assets", {
    assets: [
      {
        assetId: "CGC",
        activeDeploymentId: deployment.id,
        deployments: [deployment],
      },
    ],
  });
  respond("/setup", { adminWalletSetup: false });
  respond("/me", { role, id: "portal-test" });
  respond("/account/login-wallets", { wallets: [] });
  respond("/operator-applications", { applications: [] });
  const staticFiles: Record<string, string> = {
    "/": "index.html",
    "/app.js": "app.js",
    "/style.css": "style.css",
  };
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = staticFiles[path];
    const response = responses.get(path);
    if (file) await route.fulfill({ path: resolve("public", file) });
    else if (response) await response(route);
    else
      await route.fulfill({
        status: 404,
        json: { error: { message: `Unexpected request: ${path}` } },
      });
  });
  if (role)
    await page.addInitScript(() =>
      sessionStorage.setItem("metanomic-session", "fixture-session"),
    );
  return { page, respond };
}

const accounting = {
  reserve: "100",
  budgets: "0",
  escrow: "0",
  solvent: true,
  totalSupply: "100",
  supplyCap: "1000",
  relayerGasWei: "0",
  adminGasWei: "0",
};

test("admin cards select the right records, and mobile keyboard users can open an operation error", async (t) => {
  const { page, respond } = await mobilePage(t, "admin");
  const now = Date.now();
  const old = now - 65 * 60_000;
  respond("/allocation-schedules", { schedules: [] });
  respond("/admin/overview", {
    deployment,
    accounting,
    relayerFunding: { recent: [] },
    accounts: [],
    issuances: [],
    registrations: [],
    audit: [],
    games: [
      {
        id: "game-1",
        name: "별빛 레이스",
        operator_id: "op",
        active: 1,
        chainActive: true,
      },
    ],
    operations: [
      {
        id: "op-1",
        kind: "pay",
        resource_id: "pay-delayed",
        game_id: "game-1",
        status: "SUBMITTED",
        created_at: old,
      },
      {
        id: "op-2",
        kind: "pay",
        resource_id: "pay-fresh",
        game_id: "game-1",
        status: "SUBMITTED",
        created_at: now,
      },
      {
        id: "op-3",
        kind: "reward",
        resource_id: "reward-1",
        game_id: "game-1",
        status: "FAILED",
        error: "예산 부족",
        created_at: now,
      },
    ],
    payments: [
      {
        id: "pay-delayed",
        game_id: "game-1",
        status: "PROCESSING",
        created_at: old,
      },
      {
        id: "pay-fresh",
        game_id: "game-1",
        status: "PROCESSING",
        created_at: now,
      },
      {
        id: "pay-unclaimed",
        game_id: "game-1",
        status: "PAID",
        created_at: old,
        claim_by: Math.floor((now - 60_000) / 1000),
      },
    ],
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: /확인이 필요한 결제 2건 처리 중 1건/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "진행 중인 결제" }),
  ).toBeFocused();
  const payments = page.locator("#stalled-payments");
  await expect(
    payments.getByRole("button", { name: /확인 필요/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(payments.getByText("pay-unclaimed")).toBeVisible();
  await expect(payments.getByText("pay-fresh")).toHaveCount(0);
  await expect(payments.getByText("별빛 레이스").first()).toBeVisible();
  const noHorizontalScroll = await payments.evaluate(
    (el) => el.scrollWidth === el.clientWidth,
  );
  expect(noHorizontalScroll).toBe(true);
  await payments
    .getByRole("row")
    .filter({ hasText: "pay-delayed" })
    .getByRole("button", { name: "관련 작업 보기" })
    .click();
  await expect(
    page.getByRole("searchbox", { name: /작업·게임·결제 ID/ }),
  ).toHaveValue("pay-delayed");
  await expect(page.locator("#operations tbody [data-row-key]")).toHaveCount(1);

  await page.locator("#workspace-menu").click();
  await page.locator('[data-nav="overview"]').click();
  await expect(page.locator("#workspace-menu")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: /실패한 작업 1건/ }).click();
  await expect(
    page.getByRole("heading", { name: "블록체인 작업" }),
  ).toBeFocused();
  const error = page.getByRole("button", { name: "오류 상세 보기" });
  await error.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("예산 부족")).toBeVisible();
  await expect(page.getByRole("button", { name: "상세 닫기" })).toBeFocused();

  await page.locator("#workspace-menu").click();
  await page.locator('[data-nav="games"]').click();
  await page.getByRole("button", { name: "포털에서 끄기" }).click();
  let preview = page.getByRole("dialog", { name: "포털에서 끄기" });
  await expect(preview).toContainText("즉시 목록에서 숨기고");
  await preview.getByRole("button", { name: "취소" }).click();
  await page.getByRole("button", { name: "블록체인에서 중지" }).click();
  preview = page.getByRole("dialog", { name: "블록체인에서 중지" });
  await expect(preview).toContainText(
    "확정되면 계약이 새 결제·보상·배분을 차단",
  );
});

test("budget actions show one task at a time and confirm the selected destination and schedule", async (t) => {
  const { page, respond } = await mobilePage(t, "admin");
  respond("/admin/overview", {
    deployment,
    accounting,
    relayerFunding: { recent: [] },
    accounts: [{ id: "op", username: "별빛 운영자", wallet }],
    issuances: [],
    registrations: [],
    audit: [],
    operations: [],
    payments: [],
    games: [
      {
        id: "game-1",
        name: "별빛 레이스",
        active: 1,
        budget: "25",
        chainActive: true,
      },
    ],
  });
  const allocations: { body: unknown; key: string }[] = [];
  await page.route(`${origin}/v1/allocations`, async (route) => {
    const request = route.request();
    allocations.push({
      body: request.postDataJSON(),
      key: request.headers()["idempotency-key"],
    });
    if (allocations.length === 1)
      await route.fulfill({
        status: 503,
        json: { error: { message: "잠시 후 다시 시도하세요." } },
      });
    else
      await route.fulfill({
        status: 202,
        json: { operationId: "allocation-op" },
      });
  });
  const schedules: object[] = [];
  await page.route(`${origin}/v1/allocation-schedules`, async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { schedules } });
    schedules.push({
      ...route.request().postDataJSON(),
      scheduleId: "schedule-1",
      gameName: "별빛 레이스",
      active: true,
      nextRunAt: Date.now() + 10_000,
    });
    await route.fulfill({ status: 201, json: schedules[0] });
  });
  await page.goto(`${origin}/#budget`);
  const allocation = page.locator("#allocation-panel");
  const repeat = page.locator("#schedule-panel");
  const issuance = page.locator("#issuance-panel");
  await expect(allocation).toBeVisible();
  await expect(repeat).toBeHidden();
  await expect(issuance).toBeHidden();
  await expect(page.getByLabel("받을 게임")).toHaveValue("");
  await page.getByLabel("받을 게임").selectOption("game-1");
  await page.getByLabel("보낼 금액 (CGC)").fill("100.000001");
  await expect(
    page.getByRole("button", { name: "배분 내용 확인" }),
  ).toBeDisabled();
  await page.getByLabel("보낼 금액 (CGC)").fill("4.25");
  await page.getByRole("button", { name: "배분 내용 확인" }).click();
  const preview = page.getByRole("dialog", { name: "배분 내용을 확인하세요" });
  await expect(preview).toContainText("별빛 레이스");
  await expect(preview).toContainText("95.75 CGC");
  await preview.getByRole("button", { name: "배분 실행" }).click();
  await expect(preview).toContainText("잠시 후 다시 시도하세요.");
  await preview.getByRole("button", { name: "배분 실행" }).click();
  await expect(preview).toBeHidden();
  assert.deepEqual(
    allocations.map((entry) => entry.body),
    [
      { gameId: "game-1", assetId: "CGC", amount: "4.25" },
      { gameId: "game-1", assetId: "CGC", amount: "4.25" },
    ],
  );
  assert.ok(allocations[0].key);
  assert.equal(allocations[0].key, allocations[1].key);

  await page.getByRole("button", { name: "반복 배분", exact: true }).click();
  await expect(repeat).toBeVisible();
  await expect(allocation).toBeHidden();
  await repeat.getByRole("button", { name: "일정 추가" }).click();
  await page.getByLabel("회당 보낼 금액 (CGC)").fill("5");
  await page.getByLabel("주기").selectOption("monthly");
  await page.getByLabel("날짜").selectOption("28");
  await page.getByRole("button", { name: "일정 내용 확인" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "매월 28일 서버 시간 자정",
  );
  await page.getByRole("button", { name: "일정 등록", exact: true }).click();
  await expect(repeat.getByText("매월 28일")).toBeVisible();
  assert.equal(schedules.length, 1);

  await page.getByRole("button", { name: "CGC 발행", exact: true }).click();
  await expect(repeat).toBeHidden();
  await expect(issuance).toBeVisible();
  await page.getByLabel("받을 곳").selectOption("operator");
  await page.getByLabel("받을 운영자").selectOption("op");
  await page.getByLabel("발행 수량 (CGC)").fill("20");
  await page.getByRole("button", { name: "발행 내용 확인" }).click();
  await expect(page.getByRole("dialog")).toContainText("별빛 운영자");
  await expect(page.getByRole("dialog")).toContainText(wallet);
  await expect(page.getByRole("dialog")).toContainText(
    "발행한 수량은 되돌릴 수 없습니다.",
  );
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
});

test("an unpaid order can be resumed before earning a first reward", async (t) => {
  const { page, respond } = await mobilePage(t, "player");
  respond("/players/me/balances", { balances: [] });
  respond("/games", { games: [{ id: "game-1", name: "별빛 레이스" }] });
  const item = { name: "파란 모자", quantity: 1 };
  respond("/players/me/activity", {
    payments: [
      {
        id: "pay-pending",
        game_id: "game-1",
        status: "CREATED",
        payload: { amount: "2.5", item },
      },
    ],
    rewards: [],
  });
  respond("/payments/pay-pending", {
    paymentId: "pay-pending",
    gameId: "game-1",
    status: "CREATED",
    amount: "2.5",
    item,
  });
  await page.goto(origin);
  const pending = page.getByRole("region", { name: "결제 대기" });
  await expect(pending).toContainText("별빛 레이스 · 파란 모자 · 2.5 CGC");
  await pending.getByRole("button", { name: "결제 이어하기" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "2.5 CGC 결제 승인" }),
  ).toBeVisible();
});

test("mobile login is above the fold and surfaces recovery instructions when the address is rejected", async (t) => {
  const { page, respond } = await mobilePage(t);
  const request = `window.ethereum = { request: async ({ method }) => {
    if (method === 'wallet_requestPermissions') return [];
    if (method === 'eth_chainId') return '0x31769';
    return [${JSON.stringify(wallet)}];
  } };`;
  await page.addInitScript({ content: request });
  respond(
    "/sessions/wallet/challenges",
    { error: { code: "ORIGIN_DENIED", message: "허용되지 않은 화면입니다." } },
    403,
  );
  await page.goto(origin);
  const login = page.locator("#wallet-login");
  await expect(login).toBeInViewport({ ratio: 1 });
  await login.click();
  await page.locator("#wallet-choices button").click();
  await page.locator("#wallet-confirm-ok").click();
  await expect(page.locator("#login-feedback")).toContainText(
    "http/https와 포트까지 확인",
  );
  await expect(login).toBeEnabled();
});
