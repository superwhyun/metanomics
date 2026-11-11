import { before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { compile } from "../../scripts/compile.js";
import { accounts, fixture } from "../helpers.js";
import { ASSET, id } from "../../src/shared.js";

before(() => compile());

// A minimal EIP-6963 wallet whose typed-data signing is done by the test's
// player key through an exposed binding. Kept as source text: tsx would wrap
// named inner functions in a helper that does not exist in the page.
const injectWallet = (address: string, chainId: number) => `
  const provider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [${JSON.stringify(address)}];
      if (method === "eth_chainId") return "0x${chainId.toString(16)}";
      if (method === "wallet_requestPermissions") return [];
      if (method === "eth_signTypedData_v4") return window.testSignTyped(params[1]);
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    },
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info: { name: "Test Wallet" }, provider },
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
`;

test("hosted checkout page collects the payer's signatures and returns to the game", async (t) => {
  const f = await fixture(t, { staticFiles: true });
  await f.allocate("game-a");
  await f.call(f.credentials["game-a"], "POST", "/v1/games/game-a/rewards", {
    recipient: accounts.player.address,
    assetId: ASSET,
    amount: "10.000000",
    rewardRef: id("seed"),
  });
  await f.drain();
  const orderId = id("order");
  const payment = await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/games/game-b/payments",
    {
      payer: accounts.player.address,
      orderId,
      assetId: ASSET,
      amount: "4.000000",
      item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
    },
    200,
  );
  const session = await f.call(
    f.credentials["game-b"],
    "POST",
    `/v1/payments/${payment.paymentId}/checkout-sessions`,
    {
      returnUrl: "https://game-b.example/shop?tab=items",
      cancelUrl: "https://game-b.example/shop",
    },
    200,
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    assert.deepEqual(errors, []);
  });
  await page.exposeFunction("testSignTyped", (json: string) => {
    const { types, ...request } = JSON.parse(json);
    const { EIP712Domain, ...rest } = types;
    return accounts.player.signTypedData({ ...request, types: rest });
  });
  await page.addInitScript({
    content: injectWallet(accounts.player.address, f.deployment.chainId),
  });
  await page.route("https://game-b.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "game" }),
  );

  await page.goto(session.url);
  await expect(page.locator("#checkout-title")).toHaveText(
    "초보자 이용권 결제",
  );
  await expect(page.locator("#checkout-amount")).toHaveText("4");
  await expect(page.locator("#checkout-payer")).toHaveText(
    accounts.player.address,
  );
  await page.getByRole("button", { name: "Test Wallet으로 결제" }).click();
  await page.waitForURL(/game-b\.example/);
  const back = new URL(page.url());
  assert.equal(back.pathname, "/shop");
  assert.equal(back.searchParams.get("tab"), "items");
  assert.equal(back.searchParams.get("paymentId"), payment.paymentId);
  assert.equal(back.searchParams.get("orderId"), orderId);
  assert.equal(back.searchParams.get("checkout"), "submitted");
  await f.drain();
  assert.equal(
    (
      await f.call(
        f.credentials["game-b"],
        "GET",
        `/v1/payments/${payment.paymentId}`,
      )
    ).status,
    "PAID",
  );

  // Reopening the link after payment shows the state and only offers a way back.
  await page.goto(session.url);
  await expect(page.locator("#checkout-status")).toContainText(
    "결제가 완료되었습니다",
  );
  await expect(page.locator("#checkout-wallets button")).toHaveCount(0);
});
