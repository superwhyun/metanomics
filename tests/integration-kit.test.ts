import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";
import { id } from "../src/shared.js";
import { Metanomic, MetanomicError, verifyWebhook } from "../sdk/src/index.js";

before(() => compile());

const item = { sku: "starter-pass", name: "초보자 이용권", quantity: 1 };

async function webhookReceiver(t: any) {
  const received: { body: string; headers: any }[] = [];
  let failNext = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ body, headers: req.headers });
      res.statusCode = failNext-- > 0 ? 500 : 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/metanomic`,
    received,
    fail(count: number) {
      failNext = count;
    },
  };
}

test("SDK, hosted checkout and signed webhooks complete reward → payment → delivery", async (t) => {
  const f = await fixture(t);
  const deliver = (now?: number) => (f.app as any).deliverWebhooks(now);
  const sdk = (gameId: string) =>
    new Metanomic({
      apiUrl: `${f.networkUrl}/v1`,
      gameId,
      apiKey: f.credentials[gameId],
    });
  const gameA = sdk("game-a"),
    gameB = sdk("game-b");
  const receiver = await webhookReceiver(t);

  // Operators register webhooks; game keys cannot.
  await f.call(
    f.credentials["game-b"],
    "POST",
    "/v1/games/game-b/webhooks",
    { url: receiver.url, label: "game server" },
    403,
  );
  await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-b/webhooks",
    { url: "ftp://example.com/hook", label: "bad" },
    422,
  );
  const hook = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/games/game-b/webhooks",
    { url: receiver.url, label: "game server" },
    200,
  );
  assert.match(hook.secret, /^whsec_[0-9a-f]{64}$/);
  const listed = await f.call(
    f.tokens.operator,
    "GET",
    "/v1/games/game-b/webhooks",
  );
  assert.equal(listed.webhooks.length, 1);
  assert.equal(listed.webhooks[0].secret, undefined);
  const ping = await f.call(
    f.tokens.operator,
    "POST",
    `/v1/games/game-b/webhooks/${hook.webhookId}/tests`,
    {},
    200,
  );
  assert.deepEqual(ping, { delivered: true, status: 204, error: null });
  assert.equal(
    verifyWebhook(
      receiver.received[0].body,
      receiver.received[0].headers["metanomic-signature"],
      hook.secret,
    ).type,
    "webhook.test",
  );
  receiver.received.length = 0;

  // Reward through the SDK: retries with the same rewardRef never pay twice.
  await f.allocate("game-a");
  const rewardRef = id("weekly");
  const reward = await gameA.rewards.create({
    recipient: accounts.player.address,
    amount: "10.000000",
    rewardRef,
  });
  const again = await gameA.rewards.create({
    recipient: accounts.player.address,
    amount: "10.000000",
    rewardRef,
  });
  assert.equal(again.rewardId, reward.rewardId);
  await f.drain();
  assert.equal((await gameA.rewards.get(rewardRef))?.status, "FINALIZED");
  assert.equal(
    (await gameA.operations.wait(reward.operationId)).status,
    "FINALIZED",
  );
  await assert.rejects(
    gameA.rewards.create({
      recipient: accounts.player.address,
      amount: "11.000000",
      rewardRef,
    }),
    (e: any) => e instanceof MetanomicError && e.status === 409,
  );

  // Payment through the hosted checkout page API.
  const orderId = id("order");
  const payment = await gameB.payments.create({
    payer: accounts.player.address,
    orderId,
    amount: "4.000000",
    item,
  });
  assert.equal(payment.status, "CREATED");
  assert.equal(
    (await gameB.payments.findByOrderId(orderId))?.paymentId,
    payment.paymentId,
  );
  await assert.rejects(
    gameB.payments.checkout(payment.paymentId, {
      returnUrl: "javascript:alert(1)",
    }),
    (e: any) => e.code === "INVALID_RETURN_URL",
  );
  const session = await gameB.payments.checkout(payment.paymentId, {
    returnUrl: "https://game-b.example/shop",
  });
  const sameSession = await gameB.payments.checkout(payment.paymentId, {
    returnUrl: "https://game-b.example/shop",
  });
  assert.equal(sameSession.url, session.url);
  assert.match(session.url, /\/checkout\.html#[0-9a-f]{64}$/);
  const token = session.url.split("#")[1];
  await f.call(null, "GET", `/v1/checkout/${"0".repeat(64)}`, undefined, 404);
  const view = await f.call(null, "GET", `/v1/checkout/${token}`);
  assert.equal(view.payment.paymentId, payment.paymentId);
  assert.equal(view.payment.status, "CREATED");
  assert.equal(view.cancelUrl, "https://game-b.example/shop");
  assert.equal(view.network.chainId, f.deployment.chainId);
  assert.ok(view.payment.permit);
  // Only the payer's own signature is accepted, whoever holds the link.
  await f.call(
    null,
    "POST",
    `/v1/checkout/${token}/authorizations`,
    {
      signature: await accounts.other.signTypedData(view.payment.authorization),
      permitSignature: await accounts.other.signTypedData(view.payment.permit),
      permitDeadline: view.payment.expiresAt,
    },
    422,
  );
  const accepted = await f.call(
    null,
    "POST",
    `/v1/checkout/${token}/authorizations`,
    {
      signature: await accounts.player.signTypedData(
        view.payment.authorization,
      ),
      permitSignature: await accounts.player.signTypedData(view.payment.permit),
      permitDeadline: view.payment.expiresAt,
    },
  );
  assert.equal(accepted.paymentId, payment.paymentId);
  await f.drain();
  assert.equal((await gameB.payments.get(payment.paymentId)).status, "PAID");
  await assert.rejects(
    gameB.payments.checkout(payment.paymentId, {
      returnUrl: "https://game-b.example/other",
    }),
    (e: any) => e.code === "PAYMENT_NOT_PAYABLE",
  );

  // Webhooks: a failed delivery is retried after backoff with the same event.
  receiver.fail(1);
  await deliver();
  assert.equal(receiver.received.length, 1);
  const failed = (
    await f.call(f.tokens.operator, "GET", "/v1/games/game-b/webhooks")
  ).webhooks[0];
  assert.equal(failed.failures, 1);
  assert.equal(failed.lastStatus, 500);
  await deliver(); // still backing off
  assert.equal(receiver.received.length, 1);
  await deliver(Date.now() + 60_000);
  assert.equal(
    receiver.received[1].headers["metanomic-event-id"],
    receiver.received[0].headers["metanomic-event-id"],
  );

  // Game server reacts to the PAID webhook and delivers through the SDK.
  for await (const pay of gameB.payments.all(["PAID"])) {
    await gameB.payments.claimDelivery(pay.paymentId);
    await f.drain();
    await gameB.payments.fulfill(pay.paymentId, `delivery:${pay.paymentId}`);
    await f.drain();
  }
  assert.equal(
    (await gameB.payments.get(payment.paymentId)).status,
    "COMPLETED",
  );
  await deliver();

  const events = receiver.received
    .slice(1)
    .map((r) =>
      verifyWebhook(r.body, r.headers["metanomic-signature"], hook.secret),
    );
  assert.ok(events.every((e) => e.gameId === "game-b"));
  const cursors = events.map((e) => e.cursor);
  assert.deepEqual(
    cursors,
    [...cursors].sort((a, b) => a - b),
  );
  assert.equal(new Set(cursors).size, cursors.length);
  const types = events.map((e) => e.type);
  for (const type of [
    "pay.finalized",
    "claimDelivery.finalized",
    "fulfill.finalized",
  ])
    assert.ok(types.includes(type), `${type} in ${types}`);
  assert.ok(
    events
      .filter((e) => e.type.endsWith(".finalized"))
      .every((e) => e.resourceId === payment.paymentId),
  );
  const status = (
    await f.call(f.tokens.operator, "GET", "/v1/games/game-b/webhooks")
  ).webhooks[0];
  assert.equal(status.pendingEvents, 0);
  assert.equal(status.failures, 0);
  assert.equal(status.lastStatus, 204);

  // Tampered or stale requests are rejected by the SDK verifier.
  const last = receiver.received.at(-1)!;
  assert.throws(
    () =>
      verifyWebhook(
        last.body.replace("game-b", "game-a"),
        last.headers["metanomic-signature"],
        hook.secret,
      ),
    /Signature mismatch/,
  );
  assert.throws(
    () =>
      verifyWebhook(
        last.body,
        last.headers["metanomic-signature"],
        hook.secret,
        {
          now: Date.now() + 3600_000,
        },
      ),
    /tolerance/,
  );

  await f.call(
    f.tokens.operator,
    "DELETE",
    `/v1/games/game-b/webhooks/${hook.webhookId}`,
  );
  assert.equal(
    (await f.call(f.tokens.operator, "GET", "/v1/games/game-b/webhooks"))
      .webhooks.length,
    0,
  );
});
