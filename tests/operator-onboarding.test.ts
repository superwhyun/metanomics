import { before, test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";
import { chainIdOf } from "../src/shared.js";
import { artifact } from "../src/contracts.js";
import { disableAccount } from "../src/auth.js";

before(() => {
  compile();
});

type Wallet = {
  address: `0x${string}`;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};
async function walletSession(f: any, wallet: Wallet) {
  const challenge = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet/challenges",
    { address: wallet.address, deploymentId: f.deployment.id },
    200,
  );
  return f.call(
    null,
    "POST",
    "/v1/sessions/wallet",
    {
      challengeId: challenge.challengeId,
      signature: await wallet.signMessage({ message: challenge.message }),
    },
    200,
  );
}
async function apply(
  f: any,
  token: string,
  signer: Wallet,
  address = signer.address,
  expected = 200,
) {
  const challenge = await f.call(
    token,
    "POST",
    "/v1/operator-applications/challenges",
    { address, deploymentId: f.deployment.id },
    200,
  );
  return f.call(
    token,
    "POST",
    "/v1/operator-applications",
    {
      challengeId: challenge.challengeId,
      signature: await signer.signMessage({ message: challenge.message }),
      displayName: "Nebula Studio",
      contact: "dev@nebula.example",
      introduction: "퍼즐 게임을 만듭니다.",
    },
    expected,
  );
}

test("a signed operator application approved by the admin becomes the operator whose wallet owns registered games", async (t) => {
  const f = await fixture(t);
  const studio = privateKeyToAccount(generatePrivateKey());
  const session = await walletSession(f, studio);
  assert.equal(session.account.role, "player");

  const application = await apply(f, session.token, studio);
  assert.equal(application.status, "PENDING");
  assert.equal(application.wallet, studio.address);
  await apply(f, session.token, studio, studio.address, 409);
  assert.deepEqual(
    (
      await f.call(session.token, "GET", "/v1/operator-applications")
    ).applications.map((a: any) => a.applicationId),
    [application.applicationId],
  );

  const approval = `/v1/operator-applications/${application.applicationId}/approvals`;
  await f.call(session.token, "POST", approval, {}, 403);
  const approved = await f.call(f.tokens.admin, "POST", approval, {}, 200);
  assert.equal(approved.status, "APPROVED");
  // Idempotent retry of the same approval.
  assert.equal(
    (await f.call(f.tokens.admin, "POST", approval, {}, 200)).status,
    "APPROVED",
  );
  const account = f.store.get(
    "SELECT role,wallet FROM accounts WHERE id=?",
    session.account.id,
  );
  assert.equal(account.role, "operator");
  assert.equal(account.wallet, studio.address);

  // The existing session now acts as the operator.
  assert.deepEqual(
    (await f.call(session.token, "GET", "/v1/operator/games")).games,
    [],
  );
  const registration = await f.call(
    session.token,
    "POST",
    "/v1/game-registrations",
    {
      gameId: "nebula-puzzle",
      name: "Nebula Puzzle",
      category: "퍼즐",
      description: "별자리를 맞추는 퍼즐",
      playUrl: "https://nebula.example/play",
    },
  );
  await f.call(
    f.tokens.admin,
    "POST",
    `/v1/game-registrations/${registration.registrationId}/approvals`,
    {},
  );
  await f.drain();
  const [operator, active] = (await f.adapter.publicClient.readContract({
    address: f.deployment.settlement,
    abi: artifact("Settlement").abi,
    functionName: "games",
    args: [chainIdOf("nebula-puzzle")],
  })) as [string, boolean];
  assert.equal(operator, studio.address);
  assert.equal(active, true);
});

test("operator applications refuse foreign wallets and bad signatures, and a rejection allows reapplying", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  const studio = privateKeyToAccount(generatePrivateKey());
  const session = await walletSession(f, studio);

  // accounts.player is already the receiving wallet of player-001.
  await apply(f, session.token, accounts.player, accounts.player.address, 409);
  await apply(
    f,
    session.token,
    privateKeyToAccount(generatePrivateKey()),
    studio.address,
    422,
  );
  const challenge = await f.call(
    f.tokens.operator,
    "POST",
    "/v1/operator-applications/challenges",
    { address: accounts.operator.address, deploymentId: f.deployment.id },
    403,
  );
  assert.equal(challenge.error.code, "ROLE_DENIED");

  const first = await apply(f, session.token, studio);
  const rejection = `/v1/operator-applications/${first.applicationId}/rejections`;
  await f.call(f.tokens.admin, "POST", rejection, { reason: " " }, 422);
  const rejected = await f.call(
    f.tokens.admin,
    "POST",
    rejection,
    { reason: "연락처를 확인할 수 없습니다." },
    200,
  );
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.reviewNote, "연락처를 확인할 수 없습니다.");
  assert.equal(
    f.store.get("SELECT role FROM accounts WHERE id=?", session.account.id)
      .role,
    "player",
  );
  await f.call(
    f.tokens.admin,
    "POST",
    `/v1/operator-applications/${first.applicationId}/approvals`,
    {},
    409,
  );
  const second = await apply(f, session.token, studio);
  assert.notEqual(second.applicationId, first.applicationId);
});

test("disabled accounts lose existing sessions and cannot sign in with a password or wallet", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  disableAccount(f.store, "player-001", "sample account retired");
  const response = await f.call(
    f.tokens.player,
    "GET",
    "/v1/players/me/balances",
    undefined,
    401,
  );
  assert.equal(response.error.code, "UNAUTHENTICATED");
  assert.equal(
    (
      await f.call(
        null,
        "POST",
        "/v1/sessions",
        { username: "player", password: "player-dev" },
        403,
      )
    ).error.code,
    "ACCOUNT_DISABLED",
  );
  const challenge = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet/challenges",
    { address: accounts.player.address, deploymentId: f.deployment.id },
    200,
  );
  assert.equal(
    (
      await f.call(
        null,
        "POST",
        "/v1/sessions/wallet",
        {
          challengeId: challenge.challengeId,
          signature: await accounts.player.signMessage({
            message: challenge.message,
          }),
        },
        403,
      )
    ).error.code,
    "ACCOUNT_DISABLED",
  );
  // Other accounts are unaffected.
  await f.call(f.tokens.admin, "GET", "/v1/admin/overview");
});

test("player activity lists linked games so the portal can show link status for any registered game", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.call(f.tokens.player, "GET", "/v1/players/me/activity")).links,
    [],
  );
  await f.linkGames();
  assert.deepEqual(
    (await f.call(f.tokens.player, "GET", "/v1/players/me/activity")).links
      .map((l: any) => l.gameId)
      .sort(),
    ["game-a", "game-b"],
  );
});
