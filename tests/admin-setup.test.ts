import { before, test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "../scripts/compile.js";
import { accounts, fixture } from "./helpers.js";
import { issueAdminSetupCode } from "../src/auth.js";

before(() => {
  compile();
});

type Wallet = {
  address: `0x${string}`;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};
async function setup(
  f: any,
  wallet: Wallet,
  setupCode: string,
  expected = 200,
) {
  const challenge = await f.call(
    null,
    "POST",
    "/v1/setup/admin-wallet/challenges",
    { address: wallet.address, deploymentId: f.deployment.id, setupCode },
    200,
  );
  return f.call(
    null,
    "POST",
    "/v1/setup/admin-wallet",
    {
      challengeId: challenge.challengeId,
      signature: await wallet.signMessage({ message: challenge.message }),
      setupCode,
    },
    expected,
  );
}

test("first-run setup binds the installer's wallet to the admin account with a one-time code", async (t) => {
  const f = await fixture(t);
  const status = () => f.call(null, "GET", "/v1/setup");
  assert.equal((await status()).adminWalletSetup, false);

  const code = issueAdminSetupCode(f.store);
  assert.equal((await status()).adminWalletSetup, true);
  const installer = privateKeyToAccount(generatePrivateKey());

  const wrong = await f.call(
    null,
    "POST",
    "/v1/setup/admin-wallet/challenges",
    {
      address: installer.address,
      deploymentId: f.deployment.id,
      setupCode: "not-the-code",
    },
    403,
  );
  assert.equal(wrong.error.code, "SETUP_CODE_INVALID");

  const session = await setup(f, installer, code);
  assert.equal(session.account.role, "admin");
  assert.ok(
    f.store.get(
      "SELECT 1 FROM login_wallets WHERE address=? AND account_id='admin'",
      installer.address,
    ),
  );
  assert.equal((await status()).adminWalletSetup, false);
  // The code is single use.
  await f.call(
    null,
    "POST",
    "/v1/setup/admin-wallet/challenges",
    {
      address: installer.address,
      deploymentId: f.deployment.id,
      setupCode: code,
    },
    403,
  );

  // Afterwards the ordinary wallet login reaches the admin account.
  const challenge = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet/challenges",
    { address: installer.address, deploymentId: f.deployment.id },
    200,
  );
  const login = await f.call(
    null,
    "POST",
    "/v1/sessions/wallet",
    {
      challengeId: challenge.challengeId,
      signature: await installer.signMessage({ message: challenge.message }),
    },
    200,
  );
  assert.equal(login.account.role, "admin");
});

test("setup refuses a wallet that belongs to another account and a reissued code replaces the old one", async (t) => {
  const f = await fixture(t);
  await f.linkWallet();
  const first = issueAdminSetupCode(f.store);
  const second = issueAdminSetupCode(f.store);
  const installer = privateKeyToAccount(generatePrivateKey());
  await f.call(
    null,
    "POST",
    "/v1/setup/admin-wallet/challenges",
    {
      address: installer.address,
      deploymentId: f.deployment.id,
      setupCode: first,
    },
    403,
  );
  const taken = await setup(f, accounts.player, second, 409);
  assert.equal(taken.error.code, "WALLET_ALREADY_LINKED");
  // A refused attempt does not burn the code.
  assert.equal((await setup(f, installer, second)).account.role, "admin");
});
