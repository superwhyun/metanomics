import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Store } from "../../src/db.js";
import { Worker } from "../../src/worker.js";
import { createApi } from "../../src/api.js";
import { ASSET } from "../../src/shared.js";
import { freePort } from "../helpers.js";

async function fixture(t: any, games = true) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const store = new Store(":memory:");
  store.run(
    "INSERT INTO accounts VALUES('operator','operator','wallet-only','operator',?)",
    wallet.address,
  );
  store.run("INSERT INTO assets VALUES(?,6,'integration-test')", ASSET);
  if (games) {
    for (const [id, name] of [
      ["game-nebula", "Nebula Run"],
      ["game-harbor", "Star Harbor"],
    ]) {
      store.run(
        "INSERT INTO games VALUES(?,?,'operator',?,1)",
        id,
        name,
        wallet.address,
      );
      store.run(
        "INSERT INTO game_profiles VALUES(?,'게임 서버 연결 테스트','아케이드','https://game.example/play')",
        id,
      );
    }
    store.run(
      "INSERT INTO accounts VALUES('foreign','foreign','wallet-only','operator',NULL)",
    );
    store.run(
      "INSERT INTO games VALUES('game-private','Another Operator','foreign',?,1)",
      wallet.address,
    );
  }
  const adapter: any = {
    deployment: {
      id: "integration-test",
      chainId: 202601,
      finality: "finalized",
      rpcUrl: "https://example.invalid",
      token: wallet.address,
      settlement: wallet.address,
    },
    finalBlock: async () => ({ number: 1n, hash: `0x${"11".repeat(32)}` }),
    getGameBudget: async () => 100_000_000n,
  };
  const origin = `http://127.0.0.1:${await freePort()}`;
  const app = await createApi(
    store,
    new Worker(store, new Map([["integration-test", adapter]])),
    { origin, scheduleIntervalMs: 0 },
  );
  await app.listen({ host: "127.0.0.1", port: Number(new URL(origin).port) });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1280, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    await app.close();
    store.close();
    assert.deepEqual(errors, []);
  });
  await page.exposeFunction("integrationTestSign", (message: Hex) =>
    wallet.signMessage({ message: { raw: message } }),
  );
  await page.addInitScript({
    content: `(() => {
    const address = ${JSON.stringify(wallet.address)};
    window.ethereum = { request: async ({ method, params }) => {
      if (method === "wallet_requestPermissions") return [];
      if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [address];
      if (method === "eth_chainId") return "0x31769";
      if (method === "personal_sign") return window.integrationTestSign(params[0]);
      throw new Error("Unexpected mock-wallet request: " + method);
    } };
  })();`,
  });
  await page.goto(origin);
  await page.locator("#wallet-login").click();
  await page.locator("#wallet-choices button").click();
  await page.locator("#wallet-confirm-ok").click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#operator-games .loading")).toHaveCount(0);
  const open = () => page.locator('[data-nav="integration"]').click();
  const card = (id: string) => page.locator(`[data-integration-game="${id}"]`);
  const selectGame = (id: string) =>
    page.getByLabel("관리할 게임").selectOption(id);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const issue = async (id: string, label: string) => {
    await selectGame(id);
    await card(id)
      .getByRole("button", { name: "게임 API 키 발급", exact: true })
      .click();
    await card(id).getByLabel("키 이름", { exact: true }).fill(label);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/games/${id}/credentials`) &&
        r.request().method() === "POST",
    );
    await card(id).getByRole("button", { name: "발급", exact: true }).click();
    const issued = await (await response).json();
    await expect(card(id).getByLabel("발급된 게임 API 키")).toHaveValue(
      issued.token,
    );
    return issued;
  };
  const request = (key: string, gameId: string) =>
    fetch(`${origin}/v1/games/${gameId}/budget`, {
      headers: { authorization: `Bearer ${key}` },
    });
  return {
    page,
    store,
    origin,
    open,
    card,
    selectGame,
    clipboard,
    issue,
    request,
  };
}

test("operators can find, copy and use all three game connection settings while secrets remain one-time and game-scoped", async (t) => {
  const f = await fixture(t);
  await f.page
    .getByRole("button", { name: "연결 정보와 API 키 보기 →" })
    .first()
    .click();
  await expect(f.page.locator('[data-nav="integration"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(f.page.locator("[data-integration-game]")).toHaveCount(2);
  await expect(
    f.page.getByText("Another Operator", { exact: true }),
  ).toHaveCount(0);
  await expect(f.card("game-nebula")).toContainText(
    "발급만으로 게임 서버가 연결되지는 않습니다",
  );
  await f
    .card("game-nebula")
    .getByRole("button", { name: "API 주소 복사", exact: true })
    .click();
  assert.equal(await f.clipboard(), `${f.origin}/v1`);
  await f
    .card("game-nebula")
    .getByRole("button", { name: "게임 ID 복사", exact: true })
    .click();
  assert.equal(await f.clipboard(), "game-nebula");
  await f
    .card("game-nebula")
    .getByText("게임 서버 설정 예시", { exact: true })
    .click();
  await f
    .card("game-nebula")
    .getByRole("button", { name: "환경 변수 예시 복사", exact: true })
    .click();
  assert.equal(
    parseEnv(await f.clipboard()).METANOMIC_GAME_KEY,
    "YOUR_GAME_API_KEY",
  );

  const a = await f.issue("game-nebula", "운영 서버");
  await f
    .card("game-nebula")
    .getByRole("button", { name: "환경 변수 설정 복사", exact: true })
    .click();
  assert.deepEqual(parseEnv(await f.clipboard()), {
    METANOMIC_API_URL: `${f.origin}/v1`,
    METANOMIC_GAME_ID: "game-nebula",
    METANOMIC_GAME_KEY: a.token,
  });
  assert.equal((await f.request(a.token, "game-nebula")).status, 200);
  assert.equal((await f.request(a.token, "game-harbor")).status, 403);
  await f
    .card("game-nebula")
    .getByRole("button", { name: "실행 명령 복사", exact: true })
    .click();
  const command = await f.clipboard();
  assert.ok(command.includes(`METANOMIC_API_URL='${f.origin}/v1'`));
  assert.ok(command.includes(`METANOMIC_GAME_ID='game-nebula'`));
  assert.ok(command.includes(`METANOMIC_GAME_KEY='${a.token}'`));
  assert.ok(command.endsWith("npm run dev"));
  const b = await f.issue("game-harbor", "스테이징");
  await f
    .card("game-harbor")
    .getByRole("button", { name: "환경 변수 설정 복사", exact: true })
    .click();
  assert.equal(parseEnv(await f.clipboard()).METANOMIC_GAME_ID, "game-harbor");
  assert.equal(parseEnv(await f.clipboard()).METANOMIC_GAME_KEY, b.token);
  assert.notEqual(a.token, b.token);
  assert.equal(f.store.get("SELECT count(*) AS n FROM game_credentials").n, 2);
  const storage = await f.page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.ok(!storage.includes(a.token) && !storage.includes(b.token));
  await f.selectGame("game-nebula");
  await f
    .card("game-nebula")
    .getByRole("button", { name: "키 보관 완료 · 화면에서 숨기기" })
    .click();
  await expect(
    f.card("game-nebula").getByLabel("발급된 게임 API 키"),
  ).toHaveCount(0);
  await f.page.reload();
  await expect(f.page.locator("[data-integration-game]")).toHaveCount(2);
  await expect(f.page.locator('[aria-label="발급된 게임 API 키"]')).toHaveCount(
    0,
  );
  const html = await f.page.locator("#operator-integration").innerHTML();
  assert.ok(!html.includes(a.token) && !html.includes(b.token));
  await expect(f.card("game-nebula")).toContainText("운영 서버");
  await expect(f.card("game-harbor")).toContainText("스테이징");
  mkdirSync("artifacts", { recursive: true });
  await f.page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await f.page.screenshot({
    path: "artifacts/operator-connection-guide.png",
    fullPage: true,
  });
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await f.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await f.page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await f.page.screenshot({
    path: "artifacts/operator-connection-guide-mobile.png",
    fullPage: true,
  });
  await f.page.setViewportSize({ width: 1280, height: 1000 });
  await f.selectGame("game-harbor");
  const revoke = f
    .card("game-harbor")
    .getByRole("button", { name: "폐기", exact: true });
  await revoke.click();
  await f
    .card("game-harbor")
    .getByRole("button", { name: "정말 폐기", exact: true })
    .click();
  await expect(f.card("game-harbor")).toContainText(
    "아직 발급한 API 키가 없습니다",
  );
  assert.equal((await f.request(b.token, "game-harbor")).status, 401);
  const c = await f.issue("game-nebula", "교체 키");
  await f.page.locator("#logout").click();
  await expect(f.page.locator("#login-view")).toBeVisible();
  assert.ok(!(await f.page.locator("body").innerHTML()).includes(c.token));
});

test("a game's connection shortcut and budget preview keep the selected game", async (t) => {
  const { page, card, selectGame, store } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 650 });
  await selectGame("game-harbor");
  const secondGame = page
    .locator(".operator-game")
    .filter({ hasText: "Star Harbor" });
  await secondGame
    .getByRole("button", { name: /연결 정보와 API 키 보기/ })
    .click();
  await expect(
    card("game-harbor").getByRole("heading", { name: "Star Harbor" }),
  ).toBeFocused();
  await expect(card("game-nebula")).toBeHidden();

  await page.locator("#workspace-menu").click();
  await page.locator('[data-nav="games"]').click();
  await expect(page.getByLabel("관리할 게임")).toHaveValue("game-harbor");
  await secondGame.getByLabel("작업").selectOption("withdrawals");
  await secondGame.getByLabel("금액 (CGC)").fill("2.750000");
  await secondGame.getByRole("button", { name: "인출 내용 확인" }).click();
  const preview = page.getByRole("dialog", { name: "인출 내용을 확인하세요" });
  await expect(preview).toContainText("2.750000 CGC");
  await expect(preview).toContainText("보내는 곳Star Harbor의 보상 예산");
  await expect(preview).toContainText("받는 곳승인 지갑");
  await preview.getByRole("button", { name: "취소" }).click();
  await expect(preview).toBeHidden();
  assert.equal(
    store.get("SELECT COUNT(*) AS count FROM budget_actions").count,
    0,
  );
  await page.locator("#workspace-menu").click();
  await page.getByRole("link", { name: "결제 복구" }).click();
  await expect(page.locator("#resolution-form")).toBeVisible();
  await page.getByRole("button", { name: /환불 승인에 쓸 지갑 확인/ }).click();
  await expect(
    page.getByRole("heading", { name: "현재 로그인한 지갑" }),
  ).toBeVisible();
  await expect(page.locator("#wallet-tools summary")).toBeFocused();
  await expect(page.locator("#resolution-form")).toBeHidden();
});

test("failed key issuance keeps connection values visible and lets the operator retry", async (t) => {
  const f = await fixture(t);
  await f.open();
  let fail = true;
  await f.page.route("**/v1/games/game-nebula/credentials", async (route) => {
    if (route.request().method() === "POST" && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: { message: "키 발급을 처리하지 못했습니다." } },
      });
    } else await route.continue();
  });
  await f
    .card("game-nebula")
    .getByRole("button", { name: "게임 API 키 발급", exact: true })
    .click();
  await f
    .card("game-nebula")
    .getByLabel("키 이름", { exact: true })
    .fill("운영 서버");
  await f
    .card("game-nebula")
    .getByRole("button", { name: "발급", exact: true })
    .click();
  await expect(f.page.locator("#toast")).toHaveText(
    "키 발급을 처리하지 못했습니다.",
  );
  await expect(
    f.card("game-nebula").getByRole("button", { name: "발급", exact: true }),
  ).toBeEnabled();
  await expect(f.card("game-nebula")).toContainText(`${f.origin}/v1`);
  assert.equal(f.store.get("SELECT count(*) AS n FROM game_credentials").n, 0);
  await f.issue("game-nebula", "재시도");
  assert.equal(f.store.get("SELECT count(*) AS n FROM game_credentials").n, 1);
});

test("operators register a webhook, keep its one-time secret, test it and delete it", async (t) => {
  const f = await fixture(t);
  const received: any[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on("end", () => res.writeHead(204).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const hookUrl = `http://127.0.0.1:${(server.address() as any).port}/hook`;
  await f.open();
  const section = f.page.locator('[data-webhooks="game-nebula"]');
  await expect(section).toContainText("등록된 웹훅이 없습니다.");
  await section.getByRole("button", { name: "웹훅 등록", exact: true }).click();
  await section.getByLabel("받을 주소").fill(hookUrl);
  await section.getByLabel("웹훅 이름").fill("운영 게임 서버");
  await section.getByRole("button", { name: "등록", exact: true }).click();
  const secret = section.getByLabel("웹훅 서명 비밀값");
  await expect(secret).toHaveValue(/^whsec_[0-9a-f]{64}$/);
  const value = await secret.inputValue();
  await section.getByRole("button", { name: "환경 변수 복사" }).click();
  assert.equal(
    await f.clipboard(),
    `METANOMIC_WEBHOOK_SECRET=${JSON.stringify(value)}`,
  );
  await expect(section).toContainText(hookUrl);
  await section.getByRole("button", { name: "테스트 전송" }).click();
  await expect(f.page.locator("#toast")).toHaveText(
    "테스트 이벤트 전송 성공 (HTTP 204)",
  );
  assert.equal(received.length, 1);
  assert.match(received[0]["metanomic-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
  // The other game's card is independent.
  await expect(f.page.locator('[data-webhooks="game-harbor"]')).toContainText(
    "등록된 웹훅이 없습니다.",
  );
  await f.page.reload();
  await f.open();
  await expect(section).toContainText("운영 게임 서버");
  assert.ok(!(await f.page.locator("body").innerHTML()).includes(value));
  await section.getByRole("button", { name: "삭제", exact: true }).click();
  await section.getByRole("button", { name: "정말 삭제", exact: true }).click();
  await expect(section).toContainText("등록된 웹훅이 없습니다.");
  assert.equal(f.store.get("SELECT count(*) AS n FROM webhook_endpoints").n, 0);
});

test("an operator without approved games gets a registration path, not invented connection values", async (t) => {
  const f = await fixture(t, false);
  await f.open();
  await expect(f.page.locator("#operator-integration")).toContainText(
    "승인된 게임이 아직 없습니다",
  );
  await expect(f.page.locator(".connection-field")).toHaveCount(0);
  await f.page
    .locator("#operator-integration")
    .getByRole("button", { name: "게임 등록 신청하기 →" })
    .click();
  await expect(f.page.locator('[data-nav="register"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("operators set and clear a game's settlement depth from the game panel", async (t) => {
  const f = await fixture(t);
  const form = f.page.locator('[data-settlement-form="game-nebula"]');
  const input = form.locator('input[name="confirmations"]');
  const saved = () =>
    f.store.get(
      "SELECT confirmations FROM game_settlement WHERE game_id='game-nebula'",
    )?.confirmations ?? null;
  await expect(input).toHaveValue("");
  await input.fill("5");
  await form.getByRole("button", { name: "저장" }).click();
  await expect(f.page.locator("#toast")).toContainText("5블록");
  assert.equal(saved(), 5);
  assert.equal(
    f.store.get("SELECT 1 FROM game_settlement WHERE game_id='game-harbor'"),
    undefined,
  );
  await input.fill("");
  await form.getByRole("button", { name: "저장" }).click();
  await expect(f.page.locator("#toast")).toContainText("서버 기본값");
  assert.equal(saved(), null);
});
