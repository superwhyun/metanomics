import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Store } from "../../src/db.js";
import { Worker } from "../../src/worker.js";
import { createApi } from "../../src/api.js";
import { bindLoginWallet, loginWalletDetails } from "../../src/wallet-auth.js";
import { ASSET } from "../../src/shared.js";
import { WALLET_ALIAS_CACHE_KEY } from "../../web/wallet-aliases.js";
import { freePort } from "../helpers.js";

const wallets = [1, 2, 3].map((n) =>
  privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}`),
);
const short = (a: string) => `${a.slice(0, 7)}…${a.slice(-5)}`;
async function fixture(
  t: any,
  storage: "normal" | "blocked" | "corrupt" = "normal",
) {
  const store = new Store(":memory:");
  store.run(
    "INSERT INTO accounts VALUES('owner','owner','wallet-only','player',NULL)",
  );
  store.run("INSERT INTO players VALUES('owner')");
  for (const wallet of wallets.slice(0, 2))
    bindLoginWallet(store, "owner", wallet.address);
  store.run("INSERT INTO assets VALUES(?,6,'alias-test')", ASSET);
  const adapter: any = {
    deployment: {
      id: "alias-test",
      chainId: 202601,
      finality: "finalized",
      rpcUrl: "https://example.invalid",
      token: wallets[0].address,
      settlement: wallets[1].address,
    },
    finalBlock: async () => ({ number: 1n }),
    getBalance: async () => 0n,
  };
  const origin = `http://127.0.0.1:${await freePort()}`;
  const app = await createApi(
    store,
    new Worker(store, new Map([["alias-test", adapter]])),
    { origin, scheduleIntervalMs: 0 },
  );
  await app.listen({ port: Number(new URL(origin).port), host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1120, height: 1000 },
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
  await page.exposeFunction(
    "aliasTestSign",
    async (message: Hex, address: string) => {
      const wallet = wallets.find(
        (w) => w.address.toLowerCase() === address.toLowerCase(),
      );
      assert.ok(wallet);
      return wallet.signMessage({ message: { raw: message } });
    },
  );
  // Raw source avoids tsx's injected function-name helpers in the browser realm.
  await page.addInitScript({
    content: `
    (() => {
      const { addresses, mode, cacheKey } = ${JSON.stringify({
        addresses: wallets.map((w) => w.address.toLowerCase()),
        mode: storage,
        cacheKey: WALLET_ALIAS_CACHE_KEY,
      })};
      if (mode === "blocked") Object.defineProperty(window, "localStorage", {
        get() { throw new Error("blocked for test"); }
      });
      if (mode === "corrupt") localStorage.setItem(cacheKey, "{invalid-json");
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === "wallet_requestPermissions") return [];
          if (["eth_accounts", "eth_requestAccounts"].includes(method)) return addresses;
          if (method === "eth_chainId") return "0x31769";
          if (method === "personal_sign") return window.aliasTestSign(params[0], params[1]);
          throw new Error("Unexpected mock-wallet request: " + method);
        }
      };
    })();
  `,
  });
  await page.goto(origin);
  const openChoices = async () => {
    await expect(page.locator("#wallet-login")).toBeEnabled();
    await page.locator("#wallet-login").click();
    await expect(page.locator("#wallet-dialog")).toBeVisible();
    await page.locator("#wallet-choices button").click();
    await expect(page.locator("#account-dialog")).toBeVisible();
  };
  const finishLogin = async (index = 0) => {
    await page.locator("#account-choices .account-choice").nth(index).click();
    await page.locator("#wallet-confirm-ok").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator('[data-nav="account"]').click();
    await expect(page.locator(".login-wallet-alias")).toHaveCount(2);
  };
  const form = (index: number) =>
    page.locator(".login-wallet-alias").filter({
      has: page.locator("code", { hasText: wallets[index].address }),
    });
  const save = async (index: number, alias: string) => {
    await form(index).locator("input").fill(alias);
    await form(index).getByRole("button", { name: "별명 저장" }).click();
    await expect(form(index).locator("strong")).toHaveText(
      alias.trim().replace(/\s+/gu, " "),
    );
  };
  return { page, store, openChoices, finishLogin, form, save };
}

test(
  "real UI + isolated API + mock signer preserve aliases through logout, duplicate labels, edits and deletion",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    await f.openChoices();
    await expect(f.page.locator("#account-choices .account-choice")).toHaveText(
      wallets.map((w) => `이름 미등록 · ${short(w.address)}`),
    );
    await f.finishLogin();
    await f.save(0, "  게임용   지갑  ");
    await f.save(1, "게임용 지갑");
    assert.deepEqual(
      loginWalletDetails(f.store, "owner").map((w) => w.alias),
      ["게임용 지갑", "게임용 지갑"],
    );
    await f.page.locator("#logout").click();
    await f.openChoices();
    await expect(f.page.locator("#account-choices .account-choice")).toHaveText(
      [
        `게임용 지갑 · ${short(wallets[0].address)}`,
        `게임용 지갑 · ${short(wallets[1].address)}`,
        `이름 미등록 · ${short(wallets[2].address)}`,
      ],
    );
    const first = f.page.locator(".account-choice-row").first();
    await first.locator("summary").click();
    await expect(first.locator("code")).toBeVisible();
    await expect(first.locator("code")).toHaveText(wallets[0].address);
    mkdirSync("artifacts", { recursive: true });
    await f.page.screenshot({ path: "artifacts/wallet-aliases-selection.png" });
    // Choose the second account: aliases must not change which address is signed.
    await f.finishLogin(1);
    assert.equal(
      f.store.get(
        "SELECT actor_id FROM audit_events WHERE action='session.wallet-login' ORDER BY rowid DESC LIMIT 1",
      ).actor_id,
      "owner",
    );
    const markup = '<img src=x onerror="alert(1)">';
    await f.save(0, markup);
    await expect(f.form(0).locator("img")).toHaveCount(0);
    await f.form(1).getByRole("button", { name: "별명 삭제" }).click();
    await expect(f.form(1).locator("strong")).toHaveText("이름 미등록");
    await expect(f.form(1).locator("input")).toHaveValue("");
    await expect(
      f.form(1).getByRole("button", { name: "별명 삭제" }),
    ).toBeDisabled();
    await f.page.screenshot({
      path: "artifacts/wallet-aliases-management.png",
    });
    await f.page.locator("#logout").click();
    await f.openChoices();
    await expect(
      f.page.locator("#account-choices .account-choice").first(),
    ).toHaveText(`${markup} · ${short(wallets[0].address)}`);
    await expect(f.page.locator("#account-choices img")).toHaveCount(0);
    await expect(
      f.page.locator("#account-choices .account-choice").nth(1),
    ).toHaveText(`이름 미등록 · ${short(wallets[1].address)}`);
    await f.finishLogin();
    assert.equal(loginWalletDetails(f.store, "owner").length, 2);
  },
);

for (const mode of ["blocked", "corrupt"] as const) {
  test(
    `account selection and login still work with ${mode} alias storage`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t, mode);
      await f.openChoices();
      await expect(
        f.page.locator("#account-choices .account-choice").first(),
      ).toHaveText(`이름 미등록 · ${short(wallets[0].address)}`);
      await f.finishLogin();
      await f.save(0, "저장 확인");
      assert.ok(
        loginWalletDetails(f.store, "owner").some(
          (w) => w.alias === "저장 확인",
        ),
      );
      await f.page.locator("#logout").click();
      await f.openChoices();
      await expect(
        f.page.locator("#account-choices .account-choice").first(),
      ).toHaveText(`이름 미등록 · ${short(wallets[0].address)}`);
      await f.finishLogin();
      await expect(f.form(0).locator("strong")).toHaveText("저장 확인");
    },
  );
}
