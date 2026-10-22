import { before, test } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionExecutionError,
  createWalletClient,
  http,
  parseSignature,
  type Hex,
} from "viem";
import { compile } from "../scripts/compile.js";
import { accounts, fixture, keys } from "./helpers.js";
import {
  ASSET,
  amount,
  display,
  id,
  chainIdOf,
  emptyPermit,
  resolutionTypes,
} from "../src/shared.js";
import { artifact } from "../src/contracts.js";
import { DemoGame, NetworkClient } from "../src/game.js";
import { EvmAdapter } from "../src/chain.js";

before(() => {
  compile();
});

test("actual contracts + HTTP + independent game DBs complete the 100→10→4→1 cycle, restart after grant", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.allocate();
  const gameA = new DemoGame(
    "game-a",
    join(f.dir, "a.sqlite"),
    new NetworkClient(f.networkUrl, f.credentials["game-a"]),
  );
  let gameB = new DemoGame(
    "game-b",
    join(f.dir, "b.sqlite"),
    new NetworkClient(f.networkUrl, f.credentials["game-b"]),
  );
  t.after(() => {
    gameA.close();
    gameB.close();
  });
  const gameApps = [await gameA.app(), await gameB.app()];
  const gameTokens: string[] = [];
  for (const [index, app] of gameApps.entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { username: "pilot", password: "pilot-dev" },
    });
    gameTokens[index] = response.json().token;
    const code = await f.call(
      f.tokens.player,
      "POST",
      "/v1/player-links/codes",
      { gameId: index === 0 ? "game-a" : "game-b" },
      200,
    );
    const linked = await app.inject({
      method: "POST",
      url: "/link",
      headers: { authorization: `Bearer ${gameTokens[index]}` },
      payload: { code: code.code },
    });
    assert.equal(linked.statusCode, 200, linked.body);
  }
  const headersA = { authorization: `Bearer ${gameTokens[0]}` },
    headersB = { authorization: `Bearer ${gameTokens[1]}` };
  await gameApps[0].inject({
    method: "POST",
    url: "/runs",
    headers: headersA,
    payload: { score: 12 },
  });
  const r = await gameApps[0].inject({
    method: "POST",
    url: "/weekly-reward",
    headers: headersA,
  });
  assert.equal(r.statusCode, 200, r.body);
  await f.drain();
  await gameApps[0].inject({
    method: "POST",
    url: "/runs",
    headers: headersA,
    payload: { score: 20 },
  });
  const repeated = await gameApps[0].inject({
    method: "POST",
    url: "/weekly-reward",
    headers: headersA,
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().rewardId, r.json().rewardId);
  const orderResponse = await gameApps[1].inject({
    method: "POST",
    url: "/orders",
    headers: headersB,
    payload: { orderId: "order-001", sku: "starter-pass" },
  });
  assert.equal(orderResponse.statusCode, 200, orderResponse.body);
  const pay = orderResponse.json();
  await f.pay(pay.paymentId);
  await gameB.tick();
  await f.drain();
  gameB.afterGrant = () => {
    throw new Error("Simulated crash after atomic grant and before completion");
  };
  await gameB.tick();
  assert.match(gameB.lastError!, /Simulated crash/);
  assert.equal(gameB.get("SELECT quantity FROM inventory").quantity, 1);
  await gameApps[1].close();
  gameB.close();
  gameB = new DemoGame(
    "game-b",
    join(f.dir, "b.sqlite"),
    new NetworkClient(f.networkUrl, f.credentials["game-b"]),
  );
  await gameB.tick();
  await f.drain();
  await gameB.tick();
  assert.equal(gameB.get("SELECT quantity FROM inventory").quantity, 1);
  const newApp = await gameB.app();
  const bonus = await newApp.inject({
    method: "POST",
    url: "/bonus",
    headers: headersB,
  });
  assert.equal(bonus.statusCode, 200, bonus.body);
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "7.000000",
  );
  assert.equal(display(await f.adapter.getGameBudget("game-a")), "90.000000");
  assert.equal(display(await f.adapter.getGameBudget("game-b")), "3.000000");
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${pay.paymentId}`))
      .status,
    "COMPLETED",
  );
  const overview = await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
  assert.equal(overview.accounting.solvent, true);
  assert.equal(overview.accounting.totalSupply, "1000000.000000");
  await gameApps[0].close();
  await newApp.close();
});

test("idempotency at request and business-reference layers, budget and game access checks", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate("game-a", "10");
  const body = {
    playerId: "player-001",
    assetId: ASSET,
    amount: "10.000000",
    rewardRef: "weekly:pilot",
  };
  const first = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    body,
    202,
    "same-key",
  );
  assert.deepEqual(
    await f.call(
      f.credentials["game-a"],
      "POST",
      "/v1/games/game-a/rewards",
      body,
      202,
      "same-key",
    ),
    first,
  );
  assert.equal(
    (
      await f.call(
        f.credentials["game-a"],
        "POST",
        "/v1/games/game-a/rewards",
        body,
      )
    ).rewardId,
    first.rewardId,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...body, amount: "9" },
    409,
    "same-key",
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...body, amount: "9" },
    409,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    { ...body, rewardRef: "another" },
    409,
  );
  await f.call(
    f.credentials["game-b"],
    "GET",
    "/v1/games/game-a/budget",
    undefined,
    403,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/withdrawals",
    { assetId: ASSET, amount: "1" },
    403,
  );
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  for (const bad of ["0", "-1", "1e6", "1.0000001", "01", "1.", "9".repeat(79)])
    assert.throws(() => amount(bad));
  const issued = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/credentials",
    { label: "예산 조회 전용", scopes: ["budget"] },
    200,
  );
  const list = await f.call(
    f.tokens.operator,
    "GET",
    "/v1/games/game-a/credentials",
  );
  assert.equal(issued.label, "예산 조회 전용");
  assert.equal(
    list.credentials.find((c: any) => c.id === issued.credentialId).label,
    "예산 조회 전용",
  );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/credentials",
    { scopes: ["budget"] },
    422,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/credentials",
    { label: "   ", scopes: ["budget"] },
    422,
  );
  assert.ok(list.credentials.every((c: any) => !c.token && !c.token_hash));
  await f.call(issued.token, "GET", "/v1/games/game-a/rewards", undefined, 403);
  await f.call(
    f.tokens.operator,
    "DELETE",
    `/v1/games/game-a/credentials/${issued.credentialId}`,
    undefined,
    200,
  );
  await f.call(issued.token, "GET", "/v1/games/game-a/budget", undefined, 401);
  // A revoked key is deleted rather than listed as revoked.
  assert.ok(
    !(
      await f.call(f.tokens.operator, "GET", "/v1/games/game-a/credentials")
    ).credentials.some((c: any) => c.id === issued.credentialId),
  );
  assert.ok(
    !f.store.get(
      "SELECT 1 FROM game_credentials WHERE id=?",
      issued.credentialId,
    ),
  );
});

test("forged payment, altered amount/domain, no signature, replay, and permit frontrun", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const order = await f.payment();
  const { pay, body } = await f.signatures(order.paymentId);
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    {},
    422,
  );
  const tampered = await accounts.player.signTypedData({
    ...pay.authorization,
    message: { ...pay.authorization.message, amount: "1" },
  });
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    { signature: tampered },
    422,
  );
  const wrongDomain = await accounts.player.signTypedData({
    ...pay.authorization,
    domain: { ...pay.authorization.domain, chainId: 1 },
  });
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    { signature: wrongDomain },
    422,
  );
  const parsed = parseSignature(body.permitSignature as Hex);
  const wallet: any = createWalletClient({
    account: accounts.other,
    chain: f.adapter.publicClient.chain,
    transport: http(f.chain.url),
  });
  const hash = await wallet.writeContract({
    address: f.deployment.token,
    abi: artifact("CommonCredit").abi,
    functionName: "permit",
    args: [
      accounts.player.address,
      f.deployment.settlement,
      amount("4"),
      BigInt(pay.expiresAt),
      Number(parsed.v),
      parsed.r,
      parsed.s,
    ],
  });
  await f.adapter.publicClient.waitForTransactionReceipt({ hash });
  const accepted = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    body,
  );
  await f.drain();
  const again = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${pay.paymentId}/authorizations`,
    body,
  );
  assert.equal(again.operationId, accepted.operationId);
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "6.000000",
  );
  const op = f.store.get(
    "SELECT * FROM operations WHERE id=?",
    accepted.operationId,
  );
  await assert.rejects(
    f.adapter.buildTransaction("pay", JSON.parse(op.payload), "relayer", 99),
  );
});

test("persisted raw transaction recovers after API process restart and post-broadcast interruption", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const body = {
    playerId: "player-001",
    assetId: ASSET,
    amount: "10",
    rewardRef: "crash",
  };
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    body,
  );
  f.worker.afterBroadcast = () => {
    throw new Error("process stopped after broadcast");
  };
  await f.worker.tick();
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM transaction_attempts WHERE operation_id=?",
      reward.operationId,
    ).n,
    1,
  );
  const original = f.store.get(
    "SELECT hash FROM transaction_attempts WHERE operation_id=?",
    reward.operationId,
  ).hash;
  await f.restart();
  await f.drain();
  assert.equal(
    f.store.get(
      "SELECT hash FROM transaction_attempts WHERE operation_id=?",
      reward.operationId,
    ).hash,
    original,
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("refund vs delivery claim admits exactly one transition; claimed funds need both recovery signatures", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const order = await f.payment();
  await f.pay(order.paymentId);
  await f.call(
    f.credentials["game-b"],
    "POST",
    `/v1/payments/${order.paymentId}/delivery-claims`,
    {},
  );
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${order.paymentId}/refunds`,
    {},
  );
  await f.drain(true);
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${order.paymentId}`))
      .status,
    "DELIVERY_CLAIMED",
  );
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM operations WHERE kind IN ('refund','claimDelivery') AND status='FINALIZED' AND resource_id=?",
      order.paymentId,
    ).n,
    1,
  );
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${order.paymentId}/refunds`,
    {},
    202,
  ); // Existing losing request remains visible, never creates a second refund.
  const evidenceHash = chainIdOf("game DB locked and verified undelivered"),
    validUntil = Number((await f.adapter.finalBlock()).timestamp) + 600;
  const request = {
    domain: f.adapter.domain(),
    types: resolutionTypes,
    primaryType: "Resolution" as const,
    message: {
      paymentId: chainIdOf(order.paymentId),
      evidenceHash,
      validUntil: BigInt(validUntil),
    },
  };
  const operator = await f.call(
    f.tokens.operator,
    "POST",
    `/v1/payments/${order.paymentId}/resolutions`,
    {
      evidenceHash,
      validUntil,
      signature: await accounts.operator.signTypedData(request),
    },
  );
  assert.equal(operator.status, "AWAITING_APPROVAL");
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "6.000000",
  );
  await f.call(
    f.tokens.admin,
    "POST",
    `/v1/payments/${order.paymentId}/resolutions`,
    {
      evidenceHash,
      validUntil,
      signature: await accounts.admin.signTypedData(request),
    },
  );
  await f.drain(true);
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${order.paymentId}`))
      .status,
    "REFUNDED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("operator withdrawal signatures and reservations, contract role/budget limits, unidentified transfers", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate("game-a", "10");
  const action = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/withdrawals",
    { assetId: ASSET, amount: "10" },
    200,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/game-a/withdrawals/${action.actionId}/authorizations`,
    { signature: await accounts.other.signTypedData(action.signingRequest) },
    422,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/game-a/withdrawals/${action.actionId}/authorizations`,
    { signature: await accounts.operator.signTypedData(action.signingRequest) },
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "1",
      rewardRef: "reserved",
    },
    409,
  );
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.operator.address)),
    "10.000000",
  );
  await assert.rejects(
    f.adapter.buildTransaction(
      "reward",
      [
        chainIdOf("over"),
        chainIdOf("game-a"),
        accounts.player.address,
        amount("1"),
      ],
      "relayer",
      99,
    ),
  );
  await assert.rejects(
    f.adapter.buildTransaction(
      "allocate",
      [chainIdOf("unauthorized"), chainIdOf("game-a"), amount("1")],
      "relayer",
      99,
    ),
  );
  const opWallet: any = createWalletClient({
    account: accounts.operator,
    chain: f.adapter.publicClient.chain,
    transport: http(f.chain.url),
  });
  const hash = await opWallet.writeContract({
    address: f.deployment.token,
    abi: artifact("CommonCredit").abi,
    functionName: "transfer",
    args: [f.deployment.settlement, amount("1")],
  });
  await f.adapter.publicClient.waitForTransactionReceipt({ hash });
  const overview = await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
  assert.equal(overview.accounting.unclassified, "1.000000");
  assert.equal(display(await f.adapter.getGameBudget("game-a")), "0.000000");
});

test("wallet change and deployment activation do not redirect queued rewards or reset business deduplication", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const body = {
    playerId: "player-001",
    assetId: ASSET,
    amount: "10",
    rewardRef: "frozen-destination",
  };
  const response = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    body,
  );
  await f.linkWallet(accounts.other);
  const alternate = { ...f.deployment, id: "local-v2" };
  const adapter = new EvmAdapter(alternate, keys);
  f.worker.adapters.set(alternate.id, adapter);
  await f.call(
    f.tokens.admin,
    "POST",
    "/v1/admin/deployments/active",
    { deploymentId: alternate.id },
    200,
  );
  const again = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    body,
  );
  assert.equal(again.rewardId, response.rewardId);
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.other.address)),
    "0.000000",
  );
  assert.equal(
    f.store.get(
      "SELECT deployment_id FROM operations WHERE id=?",
      response.operationId,
    ).deployment_id,
    "local-v1",
  );
});

test("missing finality fails closed, link codes are one-use and game-bound, OpenAPI describes live routes", async (t) => {
  const f = await fixture(t);
  const code = await f.call(
    f.tokens.player,
    "POST",
    "/v1/player-links/codes",
    { gameId: "game-a" },
    200,
  );
  await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/player-links/exchange",
    { code: code.code, gamePlayerId: "pilot" },
    422,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/player-links/exchange",
    { code: code.code, gamePlayerId: "pilot" },
    200,
  );
  await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/player-links/exchange",
    { code: code.code, gamePlayerId: "pilot" },
    422,
  );
  const request = f.adapter.publicClient.getBlock;
  f.adapter.publicClient.getBlock = async () => {
    throw new Error("Finality RPC unavailable");
  };
  await f.call(f.tokens.admin, "GET", "/v1/admin/overview", undefined, 503);
  await f.worker.tick();
  assert.match(f.worker.lastError!, /확정/);
  f.adapter.publicClient.getBlock = request;
  const spec = (await f.app.inject("/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.1");
  assert.ok(
    spec.paths["/v1/payments/{paymentId}/authorizations"].post.requestBody,
  );
  assert.ok(spec.components.securitySchemes.bearerAuth);
});

test("payment expiry is checked on-chain, claim deadline refunds, and refund winning prevents delivery", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const expired = await f.payment();
  const signed = await f.signatures(expired.paymentId);
  await f.chain.client.request({
    method: "evm_increaseTime",
    params: [901],
  } as any);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.worker.tick();
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${expired.paymentId}`))
      .status,
    "EXPIRED",
  );
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${expired.paymentId}/authorizations`,
    signed.body,
    409,
  );
  await assert.rejects(
    f.adapter.buildTransaction(
      "pay",
      [signed.pay.authorization.message, signed.body.signature, emptyPermit],
      "relayer",
      99,
    ),
  );
  const order = await f.payment();
  await f.pay(order.paymentId);
  await f.chain.client.request({
    method: "evm_increaseTime",
    params: [901],
  } as any);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.drain();
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${order.paymentId}`))
      .status,
    "REFUNDED",
  );
  await f.call(
    f.credentials["game-b"],
    "POST",
    `/v1/payments/${order.paymentId}/delivery-claims`,
    {},
    409,
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  const race = await f.payment();
  await f.pay(race.paymentId);
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${race.paymentId}/refunds`,
    {},
  );
  await f.call(
    f.credentials["game-b"],
    "POST",
    `/v1/payments/${race.paymentId}/delivery-claims`,
    {},
  );
  await f.drain(true);
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${race.paymentId}`))
      .status,
    "REFUNDED",
  );
  assert.equal(
    Number((await f.adapter.read("payments", [chainIdOf(race.paymentId)]))[5]),
    4,
  );
});

test("same-nonce fee replacement preserves business payload and tracks the winning hash", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10",
      rewardRef: "replacement",
    },
  );
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [false],
  } as any);
  await f.worker.tick();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", reward.operationId)
      .status,
    "SUBMITTED",
  );
  const old = f.store.get(
    "SELECT * FROM transaction_attempts WHERE operation_id=?",
    reward.operationId,
  );
  const hash = await f.worker.replace(reward.operationId);
  await f.worker.tick();
  const latest = f.store.get(
    "SELECT * FROM transaction_attempts WHERE hash=?",
    hash,
  );
  assert.equal(latest.nonce, old.nonce);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [true],
  } as any);
  await f.drain();
  assert.equal(
    f.store.get("SELECT status FROM transaction_attempts WHERE hash=?", hash)
      .status,
    "FINALIZED",
  );
  assert.equal(
    f.store.get(
      "SELECT status FROM transaction_attempts WHERE hash=?",
      old.hash,
    ).status,
    "SUPERSEDED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  const race = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "1",
      rewardRef: "old-wins",
    },
  );
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [false],
  } as any);
  await f.worker.tick();
  const original = f.store.get(
    "SELECT * FROM transaction_attempts WHERE operation_id=?",
    race.operationId,
  );
  const unused = await f.worker.replace(race.operationId);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [true],
  } as any);
  await f.drain();
  const winner = f.store.get(
    "SELECT * FROM transaction_attempts WHERE hash=?",
    original.hash,
  );
  assert.equal(winner.status, "FINALIZED");
  assert.ok(winner.block_number);
  assert.equal(
    f.store.get("SELECT status FROM transaction_attempts WHERE hash=?", unused)
      .status,
    "SUPERSEDED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "11.000000",
  );
});

test("unfinalized inclusion rolled back by reorg reuses persisted transaction and emits no premature reward", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const anchor = await f.adapter.finalBlock();
  const snapshot = await f.chain.client.request({
    method: "evm_snapshot",
    params: [],
  } as any);
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10",
      rewardRef: "reorg",
    },
  );
  const originalFinalBlock = f.adapter.finalBlock.bind(f.adapter);
  f.adapter.finalBlock = async () => anchor;
  await f.worker.tick();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", reward.operationId)
      .status,
    "INCLUDED",
  );
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='reward.finalized'")
      .length,
    0,
  );
  const originalHash = f.store.get(
    "SELECT hash FROM transaction_attempts WHERE operation_id=?",
    reward.operationId,
  ).hash;
  await f.chain.client.request({
    method: "evm_revert",
    params: [snapshot],
  } as any);
  f.adapter.finalBlock = originalFinalBlock;
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  assert.equal(
    f.store.get(
      "SELECT hash FROM transaction_attempts WHERE operation_id=?",
      reward.operationId,
    ).hash,
    originalHash,
  );
});

test("deposit verifies destination intent; recovery DB lock forbids later grant; already granted items cannot be blocked", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate("game-a", "10");
  const withdrawal = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-a/withdrawals",
    { assetId: ASSET, amount: "5" },
    200,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/game-a/withdrawals/${withdrawal.actionId}/authorizations`,
    {
      signature: await accounts.operator.signTypedData(
        withdrawal.signingRequest,
      ),
    },
  );
  await f.drain();
  const deposit = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-b/deposits",
    { assetId: ASSET, amount: "5" },
    200,
  );
  const action = (
    await f.call(f.tokens.operator, "GET", "/v1/games/game-b/budget-actions")
  ).actions.find((a: any) => a.id === deposit.actionId);
  await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/game-b/deposits/${deposit.actionId}/authorizations`,
    {
      signature: await accounts.operator.signTypedData(deposit.signingRequest),
      permitSignature: await accounts.operator.signTypedData(action.permit),
      permitDeadline: action.expires_at,
    },
  );
  await f.drain();
  assert.equal(display(await f.adapter.getGameBudget("game-b")), "5.000000");
  const game = new DemoGame(
    "game-b",
    join(f.dir, "recover.sqlite"),
    new NetworkClient(f.networkUrl, f.credentials["game-b"]),
  );
  t.after(() => game.close());
  game.run("UPDATE accounts SET player_id='player-001' WHERE id='pilot'");
  const item = { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
    payload = {
      playerId: "player-001",
      orderId: "recover-order",
      amount: "4.000000",
      item,
    };
  game.run(
    "INSERT INTO orders VALUES(?,?,?)",
    payload.orderId,
    "pilot",
    JSON.stringify(payload),
  );
  const pay = {
    ...payload,
    paymentId: "recover-payment",
    status: "DELIVERY_CLAIMED",
  };
  game.blockForRecovery(pay.paymentId, chainIdOf("proof"));
  game.grant(pay);
  assert.equal(game.all("SELECT * FROM inventory").length, 0);
  game.grant({ ...pay, paymentId: "already-granted" });
  assert.equal(game.get("SELECT quantity FROM inventory").quantity, 1);
  assert.throws(
    () => game.blockForRecovery("already-granted", chainIdOf("proof")),
    /이미 지급/,
  );
});

test("a failed allowance preparation can be reauthorized without creating a new payment", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const order = await f.payment(),
    signed = await f.signatures(order.paymentId);
  const failed = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${order.paymentId}/authorizations`,
    { signature: signed.body.signature },
  );
  await f.drain(true);
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", failed.operationId)
      .status,
    "FAILED",
  );
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${order.paymentId}`))
      .status,
    "CREATED",
  );
  const retried = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${order.paymentId}/authorizations`,
    signed.body,
  );
  assert.equal(retried.operationId, failed.operationId);
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "6.000000",
  );
});

test("simultaneous permit nonces retry only the approval and never duplicate either payment", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const first = await f.payment(),
    second = await f.payment();
  const a = await f.signatures(first.paymentId),
    b = await f.signatures(second.paymentId);
  assert.equal(a.pay.permit.message.nonce, b.pay.permit.message.nonce);
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${first.paymentId}/authorizations`,
    a.body,
  );
  const queued = await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${second.paymentId}/authorizations`,
    b.body,
  );
  await f.drain(true);
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", queued.operationId)
      .status,
    "FAILED",
  );
  const fresh = await f.signatures(second.paymentId);
  assert.notEqual(fresh.pay.permit.message.nonce, b.pay.permit.message.nonce);
  await f.call(
    f.tokens.player,
    "POST",
    `/v1/payments/${second.paymentId}/authorizations`,
    fresh.body,
  );
  await f.drain();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "2.000000",
  );
  assert.equal(await f.adapter.read("totalEscrow"), amount("8"));
});

test("signed transaction survives a crash before broadcast; event and cursor commit roll back together", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10",
      rewardRef: "before-broadcast",
    },
  );
  f.worker.afterPersist = () => {
    throw new Error("crash before broadcast");
  };
  await f.worker.tick();
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "0.000000",
  );
  const hash = f.store.get(
    "SELECT hash FROM transaction_attempts WHERE operation_id=?",
    reward.operationId,
  ).hash;
  await f.restart();
  f.worker.afterBroadcast = () => {
    throw new Error("interrupt before projection");
  };
  f.store.db.exec(
    "CREATE TRIGGER stop_cursor BEFORE INSERT ON processing_cursors BEGIN SELECT RAISE(ABORT,'simulated event commit crash'); END;",
  );
  const cursor = f.store.get(
    "SELECT value FROM processing_cursors WHERE id=?",
    `chain:${f.deployment.id}`,
  ).value;
  await f.worker.tick();
  assert.match(f.worker.lastError!, /simulated/);
  assert.equal(
    f.store.get(
      "SELECT value FROM processing_cursors WHERE id=?",
      `chain:${f.deployment.id}`,
    ).value,
    cursor,
  );
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='chain.Rewarded'")
      .length,
    0,
  );
  f.store.db.exec("DROP TRIGGER stop_cursor;");
  f.worker.afterBroadcast = undefined;
  await f.drain();
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='chain.Rewarded'")
      .length,
    1,
  );
  assert.equal(
    f.store.get(
      "SELECT hash FROM transaction_attempts WHERE operation_id=?",
      reward.operationId,
    ).hash,
    hash,
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("authorization expiry uses current chain time even when finality is twenty minutes behind", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  const real = await f.adapter.finalBlock();
  const prior = f.adapter.finalBlock.bind(f.adapter);
  f.adapter.finalBlock = async () => ({
    ...real,
    timestamp: real.timestamp - 1200n,
  });
  const order = await f.payment();
  assert.equal(order.expiresAt, Number(real.timestamp) + 900);
  assert.ok(order.expiresAt > Number(real.timestamp));
  f.adapter.finalBlock = prior;
  assert.equal(
    Number(await f.adapter.read("claimWindow")),
    f.deployment.claimWindowSeconds,
  );
});

test("corrupted budget projection is detected against its original block, repaired, and audited", async (t) => {
  const f = await fixture(t);
  await f.allocate();
  f.store.run("UPDATE budget_snapshots SET amount='1' WHERE game_id='game-a'");
  const budget = await f.call(
    f.tokens.operator,
    "GET",
    "/v1/games/game-a/budget",
  );
  assert.equal(budget.onchain, "100.000000");
  assert.equal(
    f.store.all("SELECT * FROM audit_events WHERE action='budget.reconciled'")
      .length,
    1,
  );
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='budget.reconciled'")
      .length,
    1,
  );
});

test("standalone smoke runner resumes the same work after a pending-transaction timeout", async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, "runtime.json");
  writeFileSync(
    path,
    JSON.stringify({
      database: f.store.path,
      adminKey: keys.admin,
      relayerKey: keys.relayer,
      credentials: f.credentials,
    }),
    { mode: 0o600 },
  );
  const run = async (timeout: string) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/smoke.ts"],
      {
        env: {
          ...process.env,
          CONFIG_PATH: path,
          SMOKE_OUTPUT_DIR: f.dir,
          SMOKE_FINALITY_TIMEOUT_MS: timeout,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    return { code, output };
  };
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [false],
  } as any);
  const interrupted = await run("1");
  assert.equal(interrupted.code, 1, interrupted.output);
  const reportPath = join(f.dir, "smoke-local-v1", "report.json");
  const before = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.match(before.error, /Finality wait limit/);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.chain.client.request({
    method: "evm_setAutomine",
    params: [true],
  } as any);
  const resumed = await run("60000");
  assert.equal(resumed.code, 0, resumed.output);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.runId, before.runId);
  assert.equal(report.results.player, "7.000000");
  assert.equal(report.results.a, "90.000000");
  assert.equal(report.results.b, "3.000000");
  assert.equal(report.results.itemGrants, 1);
  assert.equal(report.supplyAtDeployment, report.results.totalSupply);
  assert.ok(BigInt(report.gasTotals.gasUsed) > 0n);
  assert.ok(BigInt(report.gasTotals.executionFeeWei) > 0n);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM allocations").n, 1);
});

test("expired recovery approvals can be replaced by new joint approvals for the same payment", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  await f.reward();
  const pay = await f.payment();
  await f.pay(pay.paymentId);
  await f.call(
    f.credentials["game-b"],
    "POST",
    `/v1/payments/${pay.paymentId}/delivery-claims`,
    {},
  );
  await f.drain();
  const evidenceHash = chainIdOf("undelivered with persistent lock");
  const approve = async (validUntil: number) => {
    const request = f.adapter.prepareAuthorization("Resolution", {
      paymentId: chainIdOf(pay.paymentId),
      evidenceHash,
      validUntil: String(validUntil),
    });
    await f.call(
      f.tokens.operator,
      "POST",
      `/v1/payments/${pay.paymentId}/resolutions`,
      {
        evidenceHash,
        validUntil,
        signature: await accounts.operator.signTypedData(request as any),
      },
    );
    return f.call(
      f.tokens.admin,
      "POST",
      `/v1/payments/${pay.paymentId}/resolutions`,
      {
        evidenceHash,
        validUntil,
        signature: await accounts.admin.signTypedData(request as any),
      },
    );
  };
  const first = await approve((await f.adapter.chainTime()) + 2);
  await f.chain.client.request({
    method: "evm_increaseTime",
    params: [3],
  } as any);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.drain(true);
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", first.operationId)
      .status,
    "FAILED",
  );
  const next = await approve((await f.adapter.chainTime()) + 600);
  assert.equal(next.operationId, first.operationId);
  await f.drain();
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${pay.paymentId}`))
      .status,
    "REFUNDED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("RPC event range limits and indexer outages cannot block finalized rewards or timeout refunds", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10",
      rewardRef: "indexer-outage",
    },
  );
  const original = f.adapter.readEvents.bind(f.adapter);
  f.adapter.readEvents = async () => {
    throw new Error("RPC rejects log range");
  };
  await f.worker.tick();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", reward.operationId)
      .status,
    "FINALIZED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
  assert.match(f.worker.lastError!, /RPC rejects log range/);
  let pages = 0;
  f.adapter.readEvents = async (from, to) => {
    assert.ok(to - from + 1n <= 200n);
    pages++;
    return original(from, to);
  };
  await f.chain.client.request({
    method: "anvil_mine",
    params: ["0x1c2"],
  } as any);
  for (let i = 0; i < 3; i++) await f.worker.tick();
  assert.ok(pages >= 3);
  assert.equal(f.worker.lastError, null);
  assert.equal(
    f.store.all("SELECT * FROM event_outbox WHERE type='chain.Rewarded'")
      .length,
    1,
  );
  const order = await f.payment();
  await f.pay(order.paymentId);
  f.adapter.readEvents = async () => {
    throw new Error("RPC indexer unavailable during refund");
  };
  await f.chain.client.request({
    method: "evm_increaseTime",
    params: [901],
  } as any);
  await f.chain.client.request({ method: "evm_mine", params: [] } as any);
  await f.drain();
  assert.equal(
    (await f.call(f.tokens.player, "GET", `/v1/payments/${order.paymentId}`))
      .status,
    "REFUNDED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("a wrapped contract RPC outage keeps its operation and reservation retryable", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  await f.linkGames();
  await f.allocate();
  const reward = await f.call(
    f.credentials["game-a"],
    "POST",
    "/v1/games/game-a/rewards",
    {
      playerId: "player-001",
      assetId: ASSET,
      amount: "10",
      rewardRef: "wrapped-rpc-outage",
    },
  );
  const original = f.adapter.buildTransaction.bind(f.adapter);
  f.adapter.buildTransaction = async () => {
    throw new ContractFunctionExecutionError(
      new BaseError("RPC connection timed out"),
      {
        abi: artifact("Settlement").abi,
        functionName: "reward",
        contractAddress: f.deployment.settlement,
      },
    );
  };
  await f.worker.tick();
  const op = f.store.get(
    "SELECT * FROM operations WHERE id=?",
    reward.operationId,
  );
  assert.equal(op.status, "RECONCILING");
  assert.equal(op.reservation, "10000000");
  assert.equal(
    f.store.all(
      "SELECT * FROM transaction_attempts WHERE operation_id=?",
      op.id,
    ).length,
    0,
  );
  f.adapter.buildTransaction = original;
  await f.drain();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", op.id).status,
    "FINALIZED",
  );
  assert.equal(
    display(await f.adapter.getBalance(accounts.player.address)),
    "10.000000",
  );
});

test("operator registration publishes a metadata-driven catalog once the contract registration is in a block and survives restart", async (t) => {
  const f = await fixture(t);
  const body = {
    gameId: "puzzle-world",
    name: "퍼즐 월드",
    description: "조각을 연결하고 공통 보상을 받는 퍼즐 게임",
    category: "퍼즐",
    playUrl: "https://example.com/puzzle",
  };
  const catalog = () => f.call(null, "GET", "/v1/games");
  const request = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    body,
  );
  assert.equal(request.status, "PENDING");
  assert.equal((await catalog()).games.length, 2);
  assert.equal(
    f.store.get("SELECT id FROM games WHERE id=?", body.gameId),
    undefined,
  );
  const approved = await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${request.registrationId}/approvals`,
    {},
  );
  const finalBlock = f.adapter.finalBlock.bind(f.adapter);
  const prior = await finalBlock();
  f.adapter.finalBlock = async () => prior;
  await f.worker.tick();
  assert.equal(
    f.store.get(
      "SELECT status FROM operations WHERE id=?",
      approved.operationId,
    ).status,
    "INCLUDED",
  );
  // Publication follows inclusion; finality can lag tens of minutes on Saigon.
  assert.equal((await catalog()).games.length, 3);
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/game-registrations"))
      .registrations[0].status,
    "APPROVED",
  );
  await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${request.registrationId}/rejections`,
    { reason: "cannot cancel an in-flight registration" },
    409,
  );
  f.adapter.finalBlock = finalBlock;
  await f.drain();
  const published = (await catalog()).games.find(
    (g: any) => g.id === body.gameId,
  );
  assert.deepEqual(published, {
    id: body.gameId,
    name: body.name,
    active: 1,
    description: body.description,
    category: body.category,
    playUrl: body.playUrl,
  });
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/game-registrations"))
      .registrations[0].status,
    "APPROVED",
  );
  assert.ok(
    (await f.call(f.tokens.operator, "GET", "/v1/operator/games")).games.some(
      (g: any) => g.id === body.gameId,
    ),
  );
  const repeated = await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${request.registrationId}/approvals`,
    {},
  );
  assert.equal(repeated.operationId, approved.operationId);
  assert.equal(
    f.store.all("SELECT * FROM operations WHERE kind='registerGame'").length,
    1,
  );
  const credentials = await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/${body.gameId}/credentials`,
    { label: "운영 서버", scopes: ["budget"] },
    200,
  );
  assert.equal(
    (await f.call(credentials.token, "GET", `/v1/games/${body.gameId}/budget`))
      .available,
    "0.000000",
  );
  await f.restart();
  assert.equal((await catalog()).games.length, 3);
  // Switching a game on or off is a portal decision applied immediately.
  await f.call(
    f.tokens.admin,
    "PATCH",
    `/v1/games/${body.gameId}`,
    {
      active: false,
    },
    200,
  );
  assert.equal((await catalog()).games.length, 2);
  assert.ok(
    (await f.call(f.tokens.operator, "GET", "/v1/operator/games")).games.some(
      (g: any) => g.id === body.gameId && !g.active,
    ),
  );
  await f.call(
    f.tokens.admin,
    "PATCH",
    `/v1/games/${body.gameId}`,
    {
      active: true,
    },
    200,
  );
  assert.equal((await catalog()).games.length, 3);
  const spec = (
    await f.app.inject({ method: "GET", url: "/openapi.json" })
  ).json();
  assert.ok(spec.paths["/v1/game-registrations/{registrationId}/approvals"]);
});

test("registration ownership, public URL validation, rejection and resubmission protect the catalog", async (t) => {
  const f = await fixture(t);
  const operator = f.store.get("SELECT * FROM accounts WHERE id='operator'");
  f.store.run(
    "INSERT INTO accounts VALUES(?,?,?,?,?)",
    "operator-2",
    "operator-2",
    operator.password_hash,
    "operator",
    accounts.other.address,
  );
  const other = (
    await f.call(
      null,
      "POST",
      "/v1/sessions",
      { username: "operator-2", password: "operator-dev" },
      200,
    )
  ).token;
  const body = {
    gameId: "new-game",
    name: "새로운 게임",
    description: "등록 검토를 위한 게임 소개입니다.",
    category: "RPG",
    playUrl: "https://example.com/game",
  };
  await f.call(f.tokens.player, "POST", "/v1/game-registrations", body, 403);
  await f.call(
    f.tokens.player,
    "GET",
    "/v1/game-registrations",
    undefined,
    403,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    { ...body, operatorId: "operator-2" },
    422,
  );
  for (const playUrl of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:password@example.com",
    "not a URL",
  ])
    await f.call(
      f.tokens.operator,
      "POST",
      "/v1/game-registrations",
      { ...body, playUrl },
      422,
    );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    { ...body, description: "   " },
    422,
  );
  const first = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    body,
  );
  const duplicate = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    body,
  );
  assert.equal(duplicate.registrationId, first.registrationId);
  const reordered = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    {
      playUrl: body.playUrl,
      category: body.category,
      description: body.description,
      name: body.name,
      gameId: body.gameId,
    },
  );
  assert.equal(reordered.registrationId, first.registrationId);
  await f.call(other, "POST", "/v1/game-registrations", body, 409);
  assert.equal(
    (await f.call(other, "GET", "/v1/game-registrations")).registrations.length,
    0,
  );
  assert.equal(
    (await f.call(other, "GET", "/v1/operator/games")).games.length,
    0,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    `/v1/game-registrations/${first.registrationId}/approvals`,
    {},
    403,
  );
  await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${first.registrationId}/rejections`,
    { reason: "  " },
    422,
  );
  const rejected = await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${first.registrationId}/rejections`,
    { reason: "실행 주소와 소개를 보완해주세요." },
    200,
  );
  assert.equal(rejected.status, "REJECTED");
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/game-registrations"))
      .registrations[0].reviewNote,
    rejected.reviewNote,
  );
  await f.call(other, "POST", "/v1/game-registrations", body, 409);
  const updated = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    {
      ...body,
      description: "소개와 실행 주소를 보완한 게임입니다.",
      playUrl: "https://example.com/updated-game",
    },
  );
  assert.equal(updated.registrationId, first.registrationId);
  assert.equal(updated.status, "PENDING");
  assert.equal(updated.reviewNote, null);
  assert.equal((await f.call(null, "GET", "/v1/games")).games.length, 2);
  assert.equal(f.store.all("SELECT * FROM game_registrations").length, 1);
});

test("failed contract registration remains hidden and can be approved again with the same game identity", async (t) => {
  const f = await fixture(t);
  const body = {
    gameId: "retry-game",
    name: "재시도 게임",
    description: "등록 실패와 재개를 확인하는 게임",
    category: "기타",
    playUrl: "https://example.com/retry",
  };
  const r = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/game-registrations",
    body,
  );
  const path = `/v1/game-registrations/${r.registrationId}/approvals`;
  const first = await f.call(f.tokens.admin, "POST", path, {});
  const build = f.adapter.buildTransaction.bind(f.adapter);
  f.adapter.buildTransaction = (
    name,
    args,
    signer,
    nonce,
    gasPrice,
    fixedGas,
  ) =>
    build(
      name,
      name === "registerGame" ? [args[0], `0x${"00".repeat(20)}`, true] : args,
      signer,
      nonce,
      gasPrice,
      fixedGas,
    );
  await f.drain(true);
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/game-registrations"))
      .registrations[0].status,
    "FAILED",
  );
  assert.equal((await f.call(null, "GET", "/v1/games")).games.length, 2);
  f.adapter.buildTransaction = build;
  const retry = await f.call(f.tokens.admin, "POST", path, {});
  assert.notEqual(retry.operationId, first.operationId);
  for (let i = 0; i < 5; i++) await f.worker.tick();
  assert.equal(
    f.store.get("SELECT status FROM operations WHERE id=?", retry.operationId)
      .status,
    "FINALIZED",
  );
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/game-registrations"))
      .registrations[0].status,
    "APPROVED",
  );
  assert.equal((await f.call(null, "GET", "/v1/games")).games.length, 3);
  assert.equal(
    f.store.all("SELECT * FROM games WHERE id=?", body.gameId).length,
    1,
  );
});

test("admin issuance funds the reserve in mint→approve→fund order or mints to an operator wallet within the cap", async (t) => {
  const f = await fixture(t);
  const tokenAbi = artifact("CommonCredit").abi;
  const supply = async () =>
    (await f.adapter.publicClient.readContract({
      address: f.deployment.token,
      abi: tokenAbi,
      functionName: "totalSupply",
    })) as bigint;
  const supplyBefore = await supply();
  const reserveBefore = (await f.adapter.read("reserve")) as bigint;
  const operatorBefore = await f.adapter.getBalance(accounts.operator.address);
  const body = {
    assetId: ASSET,
    amount: "50.000000",
    target: "reserve",
    issuanceRef: "top-up-1",
  };
  await f.call(f.tokens.operator, "POST", "/v1/issuances", body, 403);
  const first = await f.call(f.tokens.admin, "POST", "/v1/issuances", body);
  assert.equal(
    (await f.call(f.tokens.admin, "POST", "/v1/issuances", body)).issuanceId,
    first.issuanceId,
  );
  await f.call(
    f.tokens.admin,
    "POST",
    "/v1/issuances",
    { ...body, amount: "51.000000" },
    409,
  );
  await f.drain();
  assert.deepEqual(
    f.store
      .all(
        "SELECT kind,status FROM operations WHERE resource_id=? ORDER BY rowid",
        first.issuanceId,
      )
      .map((o) => [o.kind, o.status]),
    [
      ["mint", "FINALIZED"],
      ["approve", "FINALIZED"],
      ["fundReserve", "FINALIZED"],
    ],
  );
  assert.equal(await supply(), supplyBefore + amount("50"));
  assert.equal(await f.adapter.read("reserve"), reserveBefore + amount("50"));

  await f.call(
    f.tokens.admin,
    "POST",
    "/v1/issuances",
    {
      assetId: ASSET,
      amount: "5.000000",
      target: "operator",
      issuanceRef: "operator-1",
    },
    422,
  );
  const toOperator = await f.call(f.tokens.admin, "POST", "/v1/issuances", {
    assetId: ASSET,
    amount: "5.000000",
    target: "operator",
    operatorId: "operator",
    issuanceRef: "operator-1",
  });
  await f.drain();
  assert.equal(
    await f.adapter.getBalance(accounts.operator.address),
    operatorBefore + amount("5"),
  );
  assert.equal(await f.adapter.read("reserve"), reserveBefore + amount("50"));

  await f.call(
    f.tokens.admin,
    "POST",
    "/v1/issuances",
    { ...body, amount: "999999999.000000", issuanceRef: "over-cap" },
    422,
  );
  const overview = await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
  assert.deepEqual(
    overview.issuances.map((i: any) => [i.issuanceId, i.status]),
    [
      [toOperator.issuanceId, "COMPLETED"],
      [first.issuanceId, "COMPLETED"],
    ],
  );
  assert.equal(
    overview.accounting.totalSupply,
    display(supplyBefore + amount("55")),
  );
  assert.equal(
    overview.accounting.supplyCap,
    display(await f.adapter.readToken("cap")),
  );
  assert.ok(BigInt(overview.accounting.adminGasWei) > 0n);
});

test("a reverted issuance mint fails the issuance and never queues approval or reserve funding", async (t) => {
  const f = await fixture(t);
  const cap = await f.adapter.readToken("cap");
  // Bypass the API cap check to force an on-chain ERC20Capped revert.
  f.store.run(
    "INSERT INTO issuances VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    "issuance-over-cap",
    "over-cap",
    "hash",
    f.deployment.id,
    "reserve",
    f.deployment.admin,
    (cap + 1n).toString(),
    "MINTING",
    "admin",
    null,
    Date.now(),
  );
  f.worker.queue("mint", "issuance-over-cap", null, f.deployment.id, "admin", [
    f.deployment.admin,
    (cap + 1n).toString(),
  ]);
  await f.drain(true);
  assert.deepEqual(
    f.store
      .all(
        "SELECT kind,status FROM operations WHERE resource_id=?",
        "issuance-over-cap",
      )
      .map((o) => [o.kind, o.status]),
    [["mint", "FAILED"]],
  );
  const issuance = f.store.get(
    "SELECT status,error FROM issuances WHERE id=?",
    "issuance-over-cap",
  );
  assert.equal(issuance.status, "FAILED");
  assert.match(issuance.error, /^mint: /);
});
