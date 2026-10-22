import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { createApi } from "../src/api.js";
import { Store } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { passwordHash } from "../src/auth.js";
import { WalletAuth } from "../src/wallet-auth.js";
import { sha } from "../src/shared.js";

const wallets = Object.fromEntries(
  ["admin", "operator", "legacy", "new", "other"].map((name) => [
    name,
    privateKeyToAccount(generatePrivateKey()),
  ]),
);
const origin = "http://localhost:3300";
async function fixture(t: any) {
  const store = new Store(":memory:");
  for (const [id, role, wallet] of [
    ["admin", "admin", wallets.admin.address],
    ["operator", "operator", wallets.operator.address],
    ["old-player", "player", null],
  ])
    store.run(
      "INSERT INTO accounts VALUES(?,?,?,?,?)",
      id,
      id,
      passwordHash("existing-password"),
      role,
      wallet,
    );
  store.run("INSERT INTO players VALUES(?)", "old-player");
  store.run(
    "INSERT INTO games VALUES(?,?,?,?,1)",
    "game-a",
    "Existing game",
    "operator",
    wallets.operator.address,
  );
  store.run(
    "INSERT INTO player_links VALUES(?,?,?)",
    "game-a",
    "original-game-account",
    "old-player",
  );
  store.run(
    "INSERT INTO game_credentials(id,game_id,token_hash,scopes) VALUES(?,?,?,?)",
    "key",
    "game-a",
    sha("test-game-key"),
    '["links","payments"]',
  );
  let rpcCalls = 0;
  const adapter: any = {
    deployment: {
      id: "external",
      chainId: 202601,
      finality: "finalized",
      rpcUrl: "https://example.invalid",
      token: wallets.admin.address,
      settlement: wallets.operator.address,
    },
    finalBlock: () => {
      rpcCalls++;
      throw new Error("Login must not call RPC");
    },
    prepareWalletProof: (data: any) => JSON.stringify(data),
    verifyWalletProof: (message: string, signature: any, address: any) =>
      verifyMessage({ message, signature, address }),
  };
  const worker = new Worker(store, new Map([["external", adapter]]));
  const app = await createApi(store, worker, { origin, staticFiles: false });
  t.after(async () => {
    await app.close();
    assert.equal(rpcCalls, 0);
    store.close();
  });
  async function call(
    path: string,
    payload?: any,
    token?: string,
    expected = 200,
    method?: any,
  ) {
    const response = await app.inject({
      method: method ?? (payload === undefined ? "GET" : "POST"),
      url: `/v1${path}`,
      payload,
      headers: {
        origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
  }
  const challenge = (wallet = wallets.new, token?: string) =>
    call(
      token
        ? "/account/login-wallets/challenges"
        : "/sessions/wallet/challenges",
      { address: wallet.address, deploymentId: "external" },
      token,
    );
  const proof = async (c: any, wallet = wallets.new) => ({
    challengeId: c.challengeId,
    signature: await wallet.signMessage({ message: c.message }),
  });
  const login = async (wallet = wallets.new) =>
    call("/sessions/wallet", await proof(await challenge(wallet), wallet));
  const password = (username: string) =>
    call("/sessions", { username, password: "existing-password" });
  return { store, app, call, challenge, proof, login, password, worker };
}

test("SIWE challenge binds site, EVM chain, address, nonce and a five-minute acceptance window", async (t) => {
  const f = await fixture(t);
  const c = await f.challenge();
  const message = parseSiweMessage(c.message);
  assert.equal(message.domain, "localhost:3300");
  assert.equal(message.scheme, "http");
  assert.equal(message.uri, origin);
  assert.equal(message.chainId, 202601);
  assert.equal(message.address, wallets.new.address);
  assert.match(message.nonce!, /^[a-zA-Z0-9]{8,}$/);
  assert.equal(message.requestId, c.challengeId);
  assert.ok(c.expiresAt > Date.now() && c.expiresAt <= Date.now() + 300_000);
  assert.equal(
    message.expirationTime!.getTime() - message.issuedAt!.getTime(),
    8 * 3600_000,
  );
});

test("first wallet sign-in creates only a player and subsequent sign-in preserves that account", async (t) => {
  const f = await fixture(t);
  const r = await f.login();
  assert.equal(r.account.role, "player");
  assert.ok(r.token);
  assert.equal((await f.call("/me", undefined, r.token)).id, r.account.id);
  assert.equal((await f.login()).account.id, r.account.id);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM accounts").n, 4);
  assert.equal(
    f.store.get("SELECT * FROM wallet_links WHERE player_id=?", r.account.id)
      .address,
    wallets.new.address,
  );
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM operations").n, 0);
  await f.call("/operator/games", undefined, r.token, 403);
  await f.call(
    "/sessions",
    { username: r.account.username, password: "wallet-only" },
    undefined,
    401,
  );
  await f.call("/sessions/me", undefined, r.token, 200, "DELETE");
  await f.call("/me", undefined, r.token, 401);
});

test("approved administrator and operator addresses retain existing roles without creating new accounts", async (t) => {
  const f = await fixture(t);
  for (const role of ["admin", "operator"] as const) {
    const r = await f.login(wallets[role]);
    assert.equal(r.account.id, role);
    assert.equal(r.account.role, role);
  }
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM accounts").n, 3);
  const c = await f.challenge();
  await f.call(
    "/sessions/wallet",
    { ...(await f.proof(c)), role: "admin" },
    undefined,
    422,
  );
});

test("legacy receiving wallet is matched case-insensitively and keeps game links", async (t) => {
  const f = await fixture(t);
  f.store.run(
    "INSERT INTO wallet_links VALUES(?,?,?)",
    "old-player",
    202601,
    wallets.legacy.address.toLowerCase(),
  );
  const r = await f.login(wallets.legacy);
  assert.equal(r.account.id, "old-player");
  assert.equal(
    f.store.get(
      "SELECT game_player_id FROM player_links WHERE player_id=?",
      r.account.id,
    ).game_player_id,
    "original-game-account",
  );
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM accounts").n, 3);
});

test("password-authenticated account can bind a login wallet while signer and receiving wallet remain unchanged", async (t) => {
  const f = await fixture(t);
  const old = await f.password("admin");
  const c = await f.challenge(wallets.new, old.token);
  await f.call("/account/login-wallets", await f.proof(c), old.token);
  const r = await f.login();
  assert.equal(r.account.id, "admin");
  assert.equal(r.account.wallet, wallets.admin.address);
  assert.equal(
    f.store.get("SELECT operator_wallet FROM games WHERE id='game-a'")
      .operator_wallet,
    wallets.operator.address,
  );
  const list = await f.call("/account/login-wallets", undefined, old.token);
  assert.ok(list.addresses.includes(wallets.new.address));
  assert.equal(list.signingWallet, wallets.admin.address);
  assert.equal((await f.password("admin")).account.id, "admin");
});

test("binding a player login wallet preserves existing recipient and old account records", async (t) => {
  const f = await fixture(t);
  f.store.run(
    "INSERT INTO wallet_links VALUES(?,?,?)",
    "old-player",
    202601,
    wallets.legacy.address,
  );
  const old = await f.password("old-player");
  const c = await f.challenge(wallets.new, old.token);
  await f.call("/account/login-wallets", await f.proof(c), old.token);
  assert.equal((await f.login()).account.id, "old-player");
  assert.equal(
    f.store.get("SELECT address FROM wallet_links WHERE player_id='old-player'")
      .address,
    wallets.legacy.address,
  );
});

test("a wallet already belonging to another account cannot be reassigned or silently merged", async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const old = await f.password("admin");
  const c = await f.challenge(wallets.new, old.token);
  const failure = await f.call(
    "/account/login-wallets",
    await f.proof(c),
    old.token,
    409,
  );
  assert.equal(failure.error.code, "WALLET_ALREADY_LINKED");
  assert.equal((await f.login()).account.id, first.account.id);
  assert.equal(
    f.store.get("SELECT used FROM challenges WHERE id=?", c.challengeId).used,
    0,
  );
});

test("wrong signer, altered message fields and expired challenges cannot authenticate", async (t) => {
  const f = await fixture(t);
  const c = await f.challenge();
  await f.call(
    "/sessions/wallet",
    await f.proof(c, wallets.other),
    undefined,
    422,
  );
  for (const message of [
    c.message.replace("localhost:3300", "evil.example"),
    c.message.replace("202601", "1"),
    c.message.replace(wallets.new.address, wallets.other.address),
  ])
    await f.call(
      "/sessions/wallet",
      {
        challengeId: c.challengeId,
        signature: await wallets.new.signMessage({ message }),
      },
      undefined,
      422,
    );
  f.store.run("UPDATE challenges SET expires_at=0 WHERE id=?", c.challengeId);
  await f.call("/sessions/wallet", await f.proof(c), undefined, 422);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM sessions").n, 0);
});

test("replayed or concurrently submitted signatures create only one session", async (t) => {
  const f = await fixture(t);
  const proof = await f.proof(await f.challenge());
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.app.inject({
        method: "POST",
        url: "/v1/sessions/wallet",
        payload: proof,
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(
    responses.filter((r) => [409, 422].includes(r.statusCode)).length,
    1,
  );
  await f.call("/sessions/wallet", proof, undefined, 422);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM sessions").n, 1);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM accounts").n, 4);
});

test("login, account linking and another account's linking challenges are not interchangeable", async (t) => {
  const f = await fixture(t);
  const admin = await f.password("admin"),
    player = await f.password("old-player");
  const c = await f.challenge(wallets.new, admin.token),
    proof = await f.proof(c);
  await f.call("/sessions/wallet", proof, undefined, 422);
  await f.call("/account/login-wallets", proof, player.token, 422);
  const loginProof = await f.proof(await f.challenge());
  await f.call("/account/login-wallets", loginProof, admin.token, 422);
  await f.call("/account/login-wallets", proof, admin.token);
});

test("origin changes, cross-origin mutations and game credentials cannot bind login wallets", async (t) => {
  const f = await fixture(t);
  const c = await f.challenge();
  await assert.rejects(
    new WalletAuth(f.store, "https://other.example").finish(
      c.challengeId,
      (await f.proof(c)).signature,
    ),
    /로그인 사이트/,
  );
  const denied = await f.app.inject({
    method: "POST",
    url: "/v1/sessions/wallet/challenges",
    headers: { origin: "https://evil.example" },
    payload: { address: wallets.new.address, deploymentId: "external" },
  });
  assert.equal(denied.statusCode, 403);
  await f.call(
    "/account/login-wallets/challenges",
    { address: wallets.new.address, deploymentId: "external" },
    "test-game-key",
    403,
  );
  await f.call("/account/login-wallets", undefined, "test-game-key", 403);
  await f.call(
    "/account/login-wallets/challenges",
    { address: wallets.new.address, deploymentId: "external" },
    undefined,
    401,
  );
});

test("existing receiving-wallet proof also enables login and cannot attach an approved admin wallet", async (t) => {
  const f = await fixture(t);
  const old = await f.password("old-player");
  for (const [wallet, expected] of [
    [wallets.new, 200],
    [wallets.admin, 409],
  ] as const) {
    const c = await f.call(
      "/wallet-links/challenges",
      { address: wallet.address, deploymentId: "external" },
      old.token,
    );
    await f.call(
      "/wallet-links",
      await f.proof(c, wallet),
      old.token,
      expected,
    );
  }
  assert.equal((await f.login()).account.id, "old-player");
  assert.equal(
    f.store.get("SELECT address FROM wallet_links WHERE player_id='old-player'")
      .address,
    wallets.new.address,
  );
});

test("wallet identity and one-time challenge remain valid after database restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "metanomic-wallet-auth-"));
  let store = new Store(join(dir, "network.sqlite"));
  try {
    let auth = new WalletAuth(store, origin);
    const c = auth.challenge(wallets.new.address, {
      id: "external",
      chainId: 202601,
    });
    const signature = await wallets.new.signMessage({ message: c.message });
    store.close();
    store = new Store(join(dir, "network.sqlite"));
    auth = new WalletAuth(store, origin);
    const first: any = await auth.finish(c.challengeId, signature);
    store.close();
    store = new Store(join(dir, "network.sqlite"));
    auth = new WalletAuth(store, origin);
    await assert.rejects(auth.finish(c.challengeId, signature));
    const secondChallenge = auth.challenge(wallets.new.address, {
      id: "external",
      chainId: 202601,
    });
    const second: any = await auth.finish(
      secondChallenge.challengeId,
      await wallets.new.signMessage({ message: secondChallenge.message }),
    );
    assert.equal(second.account.id, first.account.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("ambiguous preexisting identities are refused instead of choosing a privileged account", async (t) => {
  const f = await fixture(t);
  f.store.run(
    "INSERT INTO wallet_links VALUES(?,?,?)",
    "old-player",
    202601,
    wallets.admin.address,
  );
  const failure = await f.call(
    "/sessions/wallet",
    await f.proof(await f.challenge(wallets.admin), wallets.admin),
    undefined,
    409,
  );
  assert.equal(failure.error.code, "WALLET_IDENTITY_CONFLICT");
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM sessions").n, 0);
});

test("public challenges reject unknown networks and throttle repeated login requests", async (t) => {
  const f = await fixture(t);
  await f.call(
    "/sessions/wallet/challenges",
    { address: wallets.new.address, deploymentId: "missing" },
    undefined,
    422,
  );
  for (let i = 0; i < 59; i++) await f.challenge();
  const failure = await f.call(
    "/sessions/wallet/challenges",
    { address: wallets.new.address, deploymentId: "external" },
    undefined,
    429,
  );
  assert.equal(failure.error.code, "AUTH_RATE_LIMITED");
});
