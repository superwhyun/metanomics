import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { DemoGame, NetworkClient } from "../src/game.js";
import { ASSET, UNIT, sha } from "../src/shared.js";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";

before(() => compile());

async function gameLogin(app: any, wallet: any) {
  const challenge = await app.inject({
    method: "POST",
    url: "/sessions/wallet/challenges",
    payload: { address: wallet.address.toLowerCase() },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const data = challenge.json();
  const signature = await wallet.signMessage({ message: data.message });
  const response = await app.inject({
    method: "POST",
    url: "/sessions/wallet",
    payload: { challengeId: data.challengeId, signature },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { token: response.json().token, data, signature };
}

test("game wallet login alone completes reward → purchase → bonus on actual contracts, with optional later portal login", async (t) => {
  const f = await fixture(t);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const games = ["game-a", "game-b"].map(
    (gameId) =>
      new DemoGame(
        gameId as any,
        join(f.dir, `${gameId}.sqlite`),
        new NetworkClient(f.networkUrl, f.credentials[gameId]),
      ),
  );
  const apps = await Promise.all(
    games.map((game, i) =>
      game.app({ origin: `https://game-${i}.example`, chainId: 31337 }),
    ),
  );
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const game of games) game.close();
  });
  const login = await Promise.all(apps.map((app) => gameLogin(app, wallet)));
  const call = async (
    index: number,
    method: string,
    url: string,
    payload?: any,
    expected = 200,
  ) => {
    const response = await apps[index].inject({
      method: method as any,
      url,
      headers: { authorization: `Bearer ${login[index].token}` },
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, expected, `${url}: ${response.body}`);
    return response.json();
  };
  const noPortalRegistration = () => {
    assert.equal(f.store.get("SELECT count(*) AS n FROM player_links").n, 0);
    assert.equal(
      f.store.get(
        "SELECT count(*) AS n FROM login_wallets WHERE address=? COLLATE NOCASE",
        wallet.address,
      ).n,
      0,
    );
    assert.equal(
      f.store.get(
        "SELECT count(*) AS n FROM wallet_links WHERE address=? COLLATE NOCASE",
        wallet.address,
      ).n,
      0,
    );
    assert.equal(
      f.store.get(
        "SELECT count(*) AS n FROM accounts WHERE username=?",
        `wallet-${wallet.address.toLowerCase().slice(2)}`,
      ).n,
      0,
    );
  };
  noPortalRegistration();
  assert.equal(
    parseSiweMessage(login[0].data.message).domain,
    "game-0.example",
  );
  await f.allocate("game-a");
  await f.allocate("game-b");
  await call(0, "POST", "/runs", { score: 12 });
  // The game derives the recipient from its own verified login, ignoring client hints.
  const reward = await call(0, "POST", "/weekly-reward", {
    recipient: accounts.other.address,
  });
  await f.drain();
  const rewardData = JSON.parse(
    f.store.get("SELECT payload FROM rewards WHERE id=?", reward.rewardId)
      .payload,
  );
  assert.equal(rewardData.recipient, wallet.address);
  assert.equal(rewardData.playerId, undefined);
  assert.equal(
    (await call(0, "POST", "/weekly-reward")).rewardId,
    reward.rewardId,
  );
  assert.equal(await f.adapter.getBalance(wallet.address), 10n * UNIT);
  noPortalRegistration();

  const order = await call(1, "POST", "/orders", {
    orderId: "wallet-order",
    sku: "starter-pass",
  });
  assert.equal(order.payer, wallet.address);
  assert.equal(order.playerId, undefined);
  const pay = await call(1, "GET", "/orders/wallet-order");
  const signatures = {
    signature: await wallet.signTypedData(pay.authorization),
    permitSignature: await wallet.signTypedData(pay.permit),
    permitDeadline: pay.expiresAt,
  };
  await call(
    1,
    "POST",
    "/orders/wallet-order/authorizations",
    {
      ...signatures,
      signature: await accounts.other.signTypedData(pay.authorization),
    },
    422,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    signatures,
    403,
  );
  await f.call(
    f.tokens.player,
    "GET",
    `/v1/payments/${pay.paymentId}`,
    undefined,
    403,
  );
  await f.call(
    f.tokens.player,
    "GET",
    `/v1/operations/${reward.operationId}`,
    undefined,
    403,
  );
  await call(1, "POST", "/orders/wallet-order/authorizations", signatures);
  await f.drain();
  await games[1].tick();
  await f.drain();
  await games[1].tick();
  await f.drain();
  await games[1].tick();
  assert.equal(games[1].lastError, null);
  assert.equal(games[1].get("SELECT quantity FROM inventory").quantity, 1);
  assert.equal(
    (await call(1, "GET", "/orders/wallet-order")).status,
    "COMPLETED",
  );
  const bonus = await call(1, "POST", "/bonus");
  await f.drain();
  assert.equal(await f.adapter.getBalance(wallet.address), 7n * UNIT);
  assert.equal((await call(1, "POST", "/bonus")).rewardId, bonus.rewardId);
  noPortalRegistration();

  // The portal is optional: a first login later discovers historical wallet activity.
  const challenge = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet/challenges",
    { address: wallet.address, deploymentId: f.deployment.id },
    200,
  );
  const portal = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet",
    {
      challengeId: challenge.challengeId,
      signature: await wallet.signMessage({ message: challenge.message }),
    },
    200,
  );
  const activity = await f.call(portal.token, "GET", "/v1/players/me/activity");
  assert.equal(activity.links.length, 0);
  assert.equal(activity.rewards.length, 2);
  assert.equal(activity.payments.length, 1);
  await f.call(portal.token, "GET", `/v1/operations/${reward.operationId}`);
  await f.call(portal.token, "GET", `/v1/payments/${pay.paymentId}`);
  const balances = await f.call(portal.token, "GET", "/v1/players/me/balances");
  assert.equal(balances.balances[0].amount, "7.000000");
});

test("address-based game requests retain authentication, budget, target validation and idempotency", async (t) => {
  const f = await fixture(t);
  await f.allocate();
  const base = {
    recipient: accounts.other.address,
    assetId: ASSET,
    amount: "10.000000",
    rewardRef: "wallet-ref",
  };
  await f.call(null, "POST", "/v1/games/game-a/rewards", base, 401);
  await f.call(f.tokens.player, "POST", "/v1/games/game-a/rewards", base, 403);
  await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/games/game-a/rewards",
    base,
    403,
  );
  const first = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    base,
  );
  const again = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...base, recipient: base.recipient.toLowerCase() },
  );
  assert.equal(again.rewardId, first.rewardId);
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...base, recipient: accounts.player.address },
    409,
  );
  for (const target of [
    {},
    { recipient: "bad" },
    { recipient: "0x0000000000000000000000000000000000000000" },
    { recipient: accounts.other.address, playerId: "player-001" },
  ]) {
    await f.call(
      f.credentials["game-a"],
      "POST",
      "/v1/games/game-a/rewards",
      { assetId: ASSET, amount: "1.000000", rewardRef: "invalid", ...target },
      422,
    );
  }
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...base, rewardRef: "over-budget", amount: "1000.000000" },
    409,
  );
  const payment = {
    orderId: "invalid",
    assetId: ASSET,
    amount: "1.000000",
    item: { sku: "pass", name: "Pass", quantity: 1 },
  };
  await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/games/game-b/payments",
    payment,
    422,
  );
  await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/games/game-b/payments",
    { ...payment, payer: accounts.other.address, playerId: "player-001" },
    422,
  );
  await f.drain();
  assert.equal(await f.adapter.getBalance(accounts.other.address), 10n * UNIT);
});

test("game wallet sign-in binds domain and nonce, rejects forged/expired/replayed proofs and keeps its own account", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "game-login-"));
  const game = new DemoGame(
    "game-a",
    join(dir, "game.sqlite"),
    {} as NetworkClient,
  );
  const app = await game.app({
    origin: "https://game.example",
    chainId: 202601,
  });
  t.after(async () => {
    await app.close();
    game.close();
    rmSync(dir, { recursive: true });
  });
  const first = await gameLogin(app, accounts.player);
  const parsed = parseSiweMessage(first.data.message);
  assert.equal(parsed.chainId, 202601);
  assert.equal(parsed.domain, "game.example");
  assert.equal(parsed.uri, "https://game.example");
  const replay = await app.inject({
    method: "POST",
    url: "/sessions/wallet",
    payload: {
      challengeId: first.data.challengeId,
      signature: first.signature,
    },
  });
  assert.equal(replay.statusCode, 422);
  const second = await gameLogin(app, accounts.player);
  assert.equal(
    game.get(
      "SELECT expires_at FROM sessions WHERE token_hash=?",
      sha(second.token),
    ).expires_at,
    parseSiweMessage(second.data.message).expirationTime?.getTime(),
  );
  assert.equal(
    game.get("SELECT count(*) AS n FROM accounts WHERE wallet IS NOT NULL").n,
    1,
  );
  const me = await app.inject({
    method: "GET",
    url: "/me",
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(me.json().address, accounts.player.address);
  assert.equal(me.json().playerId, null);
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/sessions/wallet/challenges",
      payload: { address: accounts.player.address },
    })
  ).json();
  const wrong = await app.inject({
    method: "POST",
    url: "/sessions/wallet",
    payload: {
      challengeId: challenge.challengeId,
      signature: await accounts.other.signMessage({
        message: challenge.message,
      }),
    },
  });
  assert.equal(wrong.statusCode, 422);
  game.run(
    "UPDATE wallet_challenges SET expires_at=0 WHERE id=?",
    challenge.challengeId,
  );
  const expired = await app.inject({
    method: "POST",
    url: "/sessions/wallet",
    payload: {
      challengeId: challenge.challengeId,
      signature: await accounts.player.signMessage({
        message: challenge.message,
      }),
    },
  });
  assert.equal(expired.statusCode, 422);
  const foreign = await app.inject({
    method: "POST",
    url: "/sessions/wallet/challenges",
    headers: { origin: "https://other.example" },
    payload: { address: accounts.player.address },
  });
  assert.equal(foreign.statusCode, 403);
  const otherApp = await game.app({
    origin: "https://other.example",
    chainId: 202601,
  });
  t.after(() => otherApp.close());
  const local = (
    await app.inject({
      method: "POST",
      url: "/sessions/wallet/challenges",
      payload: { address: accounts.player.address },
    })
  ).json();
  const crossDomain = await otherApp.inject({
    method: "POST",
    url: "/sessions/wallet",
    payload: {
      challengeId: local.challengeId,
      signature: await accounts.player.signMessage({ message: local.message }),
    },
  });
  assert.equal(crossDomain.statusCode, 422);
});
