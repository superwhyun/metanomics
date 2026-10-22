import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { mnemonicToAccount } from "viem/accounts";
import type { Hex } from "viem";
import assert from "node:assert/strict";
import { startLocalChain } from "../scripts/local-chain.js";
import {
  deployContracts,
  provisionStore,
  DEVELOPMENT_MNEMONIC,
} from "../src/provision.js";
import { Store } from "../src/db.js";
import { EvmAdapter } from "../src/chain.js";
import { Worker } from "../src/worker.js";
import { createApi } from "../src/api.js";
import { ASSET, id, type SigningRequest } from "../src/shared.js";

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
export const accounts = Object.fromEntries(
  ["admin", "relayer", "operator", "player", "other"].map((name, i) => [
    name,
    mnemonicToAccount(DEVELOPMENT_MNEMONIC, { addressIndex: i }),
  ]),
);
export const keys: any = Object.fromEntries(
  Object.entries(accounts).map(([name, account]) => [
    name,
    `0x${Buffer.from(account.getHdKey().privateKey!).toString("hex")}`,
  ]),
);
export async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "metanomic-"));
  const chain = await startLocalChain(await freePort());
  const deployment = await deployContracts(chain.url, 31337, keys);
  const storePath = join(dir, "network.sqlite");
  let store = new Store(storePath);
  const credentials = provisionStore(store, deployment, keys, {
    admin: "admin-dev",
    operator: "operator-dev",
    player: "player-dev",
  });
  const adapter = new EvmAdapter(deployment, keys);
  let worker = new Worker(store, new Map([[deployment.id, adapter]]));
  let app = await createApi(store, worker, { staticFiles: false });
  const networkUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = async (
    token: string | null,
    method: string,
    url: string,
    body?: any,
    expected = method === "POST" ? 202 : 200,
    key = id("request"),
  ) => {
    const response = await app.inject({
      method: method as any,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(
      response.statusCode,
      expected,
      `${method} ${url}: ${response.body}`,
    );
    return response.json();
  };
  const tokens: Record<string, string> = {};
  for (const name of ["admin", "operator", "player"])
    tokens[name] = (
      await call(
        null,
        "POST",
        "/v1/sessions",
        { username: name, password: `${name}-dev` },
        200,
      )
    ).token;
  async function linkWallet(account = accounts.player) {
    const proof = await call(
      tokens.player,
      "POST",
      "/v1/wallet-links/challenges",
      { address: account.address, deploymentId: deployment.id },
      200,
    );
    return call(
      tokens.player,
      "POST",
      "/v1/wallet-links",
      {
        challengeId: proof.challengeId,
        signature: await account.signMessage({ message: proof.message }),
      },
      200,
    );
  }
  async function linkGames() {
    for (const gameId of ["game-a", "game-b"]) {
      const code = await call(
        tokens.player,
        "POST",
        "/v1/player-links/codes",
        { gameId },
        200,
      );
      await call(
        credentials[gameId],
        "POST",
        "/v1/player-links/exchange",
        { code: code.code, gamePlayerId: "pilot" },
        200,
      );
    }
  }
  async function drain(allowFailed = false) {
    for (let i = 0; i < 30; i++) {
      await worker.tick();
      const pending = store.all(
        "SELECT id,status,error FROM operations WHERE status NOT IN ('FINALIZED','FAILED')",
      );
      if (!pending.length) {
        if (!allowFailed)
          assert.deepEqual(
            store.all(
              "SELECT kind,error FROM operations WHERE status='FAILED'",
            ),
            [],
          );
        return;
      }
      if (i === 29)
        assert.fail(
          `Unresolved operations ${JSON.stringify(pending)}; worker=${worker.lastError}`,
        );
    }
  }
  async function allocate(gameId = "game-a", value = "100.000000") {
    const result = await call(tokens.admin, "POST", "/v1/allocations", {
      gameId,
      assetId: ASSET,
      amount: value,
      period: id("week"),
      allocationType: "weekly",
    });
    await drain();
    return result;
  }
  async function reward(value = "10.000000", rewardRef = id("ref")) {
    const result = await call(
      credentials["game-a"],
      "POST",
      "/v1/games/game-a/rewards",
      { playerId: "player-001", assetId: ASSET, amount: value, rewardRef },
    );
    await drain();
    return result;
  }
  async function payment(value = "4.000000", orderId = id("order")) {
    return call(
      credentials["game-b"],
      "POST",
      "/v1/games/game-b/payments",
      {
        playerId: "player-001",
        orderId,
        assetId: ASSET,
        amount: value,
        item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
      },
      200,
    );
  }
  async function signatures(paymentId: string) {
    const pay = await call(tokens.player, "GET", `/v1/payments/${paymentId}`);
    return {
      pay,
      body: {
        signature: await accounts.player.signTypedData(pay.authorization),
        permitSignature: await accounts.player.signTypedData(pay.permit),
        permitDeadline: pay.expiresAt,
      },
    };
  }
  async function pay(paymentId: string) {
    const s = await signatures(paymentId);
    const result = await call(
      tokens.player,
      "POST",
      `/v1/payments/${paymentId}/authorizations`,
      s.body,
    );
    await drain();
    return result;
  }
  async function restart() {
    await app.close();
    store.close();
    store = new Store(storePath);
    worker = new Worker(store, new Map([[deployment.id, adapter]]));
    app = await createApi(store, worker, { staticFiles: false });
  }
  t.after(async () => {
    await app.close();
    store.close();
    chain.child.kill("SIGTERM");
    await new Promise((r) => chain.child.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    chain,
    deployment,
    adapter,
    credentials,
    tokens,
    call,
    linkWallet,
    linkGames,
    drain,
    allocate,
    reward,
    payment,
    signatures,
    pay,
    restart,
    get store() {
      return store;
    },
    get worker() {
      return worker;
    },
    get app() {
      return app;
    },
    networkUrl,
  };
}
