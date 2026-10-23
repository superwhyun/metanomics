import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  AppError,
  id,
  opaque,
  sha,
  json,
  canonical,
  ASSET,
  requireThat,
} from "./shared.js";
import { passwordHash, passwordMatches } from "./auth.js";
import { GameWalletAuth } from "./game-wallet-auth.js";

export class NetworkClient {
  constructor(
    public baseUrl: string,
    private credential: string,
  ) {}
  async call(path: string, body?: any, key?: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: body === undefined ? undefined : json(body),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as any;
    if (!response.ok)
      throw new AppError(
        response.status,
        result.error?.code ?? "NETWORK_ERROR",
        result.error?.message ?? "Network request failed",
      );
    return result;
  }
}
export class DemoGame {
  db: DatabaseSync;
  busy = false;
  afterGrant?: (paymentId: string) => void;
  lastError: string | null = null;
  constructor(
    public gameId: "game-a" | "game-b",
    path: string,
    public network: NetworkClient,
    playerPassword = "pilot-dev",
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,player_id TEXT,score INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT,expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS deliveries(payment_id TEXT PRIMARY KEY,account_id TEXT,status TEXT NOT NULL,item TEXT NOT NULL,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS inventory(account_id TEXT,sku TEXT,quantity INTEGER NOT NULL,PRIMARY KEY(account_id,sku));
      CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,account_id TEXT,score INTEGER,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,account_id TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_locks(payment_id TEXT PRIMARY KEY,evidence_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_challenges(id TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    `);
    if (
      !this.all("PRAGMA table_info(accounts)").some(
        (column) => column.name === "wallet",
      )
    )
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN wallet TEXT COLLATE NOCASE",
      );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS game_wallet_identity ON accounts(wallet COLLATE NOCASE) WHERE wallet IS NOT NULL",
    );
    this.run(
      "INSERT OR IGNORE INTO accounts(id,username,password_hash) VALUES(?,?,?)",
      "pilot",
      "pilot",
      passwordHash(playerPassword),
    );
  }
  get(sql: string, ...args: any[]): any {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: any[]): any[] {
    return this.db.prepare(sql).all(...args);
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  grant(pay: any) {
    if (pay.status !== "DELIVERY_CLAIMED")
      throw new AppError(
        409,
        "NOT_CLAIMED",
        "지급 시작이 확정되지 않았습니다.",
      );
    const orderOwner = this.get(
      "SELECT account_id FROM orders WHERE id=?",
      pay.orderId,
    );
    const account =
      orderOwner &&
      this.get("SELECT * FROM accounts WHERE id=?", orderOwner.account_id);
    if (!account) throw new Error("Unknown game account");
    if (
      account.wallet
        ? account.wallet.toLowerCase() !== String(pay.payer).toLowerCase()
        : account.player_id !== pay.playerId
    )
      throw new Error("Order payer mismatch");
    this.transaction(() => {
      if (
        this.get(
          "SELECT * FROM recovery_locks WHERE payment_id=?",
          pay.paymentId,
        )
      )
        return;
      if (
        this.get("SELECT * FROM deliveries WHERE payment_id=?", pay.paymentId)
      )
        return;
      const order = this.get(
        "SELECT * FROM orders WHERE id=? AND account_id=?",
        pay.orderId,
        account.id,
      );
      if (!order) throw new Error("Unknown local order");
      const expected = JSON.parse(order.payload);
      if (
        canonical(pay.item) !== canonical(expected.item) ||
        pay.amount !== expected.amount
      )
        throw new Error("Order mismatch");
      this.run(
        "INSERT INTO deliveries VALUES(?,?,?,?,?)",
        pay.paymentId,
        account.id,
        "DELIVERED",
        json(pay.item),
        Date.now(),
      );
      this.run(
        "INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(account_id,sku) DO UPDATE SET quantity=quantity+excluded.quantity",
        account.id,
        pay.item.sku,
        pay.item.quantity,
      );
    });
    if (
      this.get(
        "SELECT * FROM deliveries WHERE payment_id=? AND status='DELIVERED'",
        pay.paymentId,
      )
    )
      this.afterGrant?.(pay.paymentId);
  }
  // Used by the operator CLI. This transaction is the same lock used by grant().
  blockForRecovery(paymentId: string, evidenceHash: string) {
    return this.transaction(() => {
      const lock = this.get(
        "SELECT * FROM recovery_locks WHERE payment_id=?",
        paymentId,
      );
      if (lock && lock.evidence_hash !== evidenceHash)
        throw new AppError(
          409,
          "EVIDENCE_CONFLICT",
          "이미 설정된 복구 증거와 다릅니다.",
        );
      const delivery = this.get(
        "SELECT * FROM deliveries WHERE payment_id=?",
        paymentId,
      );
      if (delivery?.status === "DELIVERED")
        throw new AppError(
          409,
          "ALREADY_DELIVERED",
          "이미 지급된 주문은 예외 환불할 수 없습니다.",
        );
      this.run(
        "INSERT INTO recovery_locks VALUES(?,?) ON CONFLICT(payment_id) DO NOTHING",
        paymentId,
        evidenceHash,
      );
      return { paymentId, blocked: true, evidenceHash };
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const eventCursor =
        this.get("SELECT value FROM cursors WHERE id='events'")?.value ?? "0";
      const batch = await this.network.call(
        `/games/${this.gameId}/events?cursor=${eventCursor}`,
      );
      // An interrupted page is replayed. A complete sweep does not depend on the event cursor.
      let cursor = 0;
      for (;;) {
        const page = await this.network.call(
          `/games/${this.gameId}/payments?status=PAID,DELIVERY_CLAIMED&cursor=${cursor}`,
        );
        for (const pay of page.payments) {
          if (
            this.get(
              "SELECT * FROM recovery_locks WHERE payment_id=?",
              pay.paymentId,
            )
          )
            continue;
          if (pay.status === "PAID") {
            await this.network.call(
              `/payments/${pay.paymentId}/delivery-claims`,
              {},
              `claim:${pay.paymentId}`,
            );
          } else {
            this.grant(pay);
            if (
              this.get(
                "SELECT * FROM deliveries WHERE payment_id=? AND status='DELIVERED'",
                pay.paymentId,
              )
            )
              await this.network.call(
                `/payments/${pay.paymentId}/fulfillments`,
                { deliveryRef: `delivery:${pay.paymentId}` },
                `fulfill:${pay.paymentId}`,
              );
          }
        }
        if (page.payments.length === 0) break;
        cursor = page.nextCursor;
      }
      this.transaction(() =>
        this.run(
          "INSERT INTO cursors VALUES('events',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          String(batch.nextCursor),
        ),
      );
      this.lastError = null;
    } catch (e: any) {
      this.lastError = e.message;
    } finally {
      this.busy = false;
    }
  }
  async app(options: { origin?: string; chainId?: number } = {}) {
    const origin = new URL(
      options.origin ??
        `http://localhost:${this.gameId === "game-a" ? 3401 : 3402}`,
    ).origin;
    const walletAuth = new GameWalletAuth(
      this,
      origin,
      options.chainId ?? 31337,
    );
    const app = Fastify({
      ajv: { customOptions: { removeAdditional: false } },
    });
    app.setErrorHandler((e: any, _req, reply) =>
      reply.code(e.status ?? (e.validation ? 422 : 500)).send({
        error: {
          code: e.code ?? "GAME_ERROR",
          message: e.status ? e.message : "게임 요청 처리에 실패했습니다.",
        },
      }),
    );
    const loginAttempts = new Map<string, { count: number; until: number }>();
    app.addHook("onRequest", async (req) => {
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.origin
      )
        requireThat(req.headers.origin === origin, 403, "ORIGIN_DENIED");
      if (req.method === "POST" && req.url.startsWith("/sessions/wallet")) {
        const now = Date.now();
        for (const [ip, entry] of loginAttempts)
          if (entry.until <= now) loginAttempts.delete(ip);
        const entry = loginAttempts.get(req.ip) ?? {
          count: 0,
          until: now + 60_000,
        };
        requireThat(
          entry.count < 60 &&
            (loginAttempts.has(req.ip) || loginAttempts.size < 1000),
          429,
          "AUTH_RATE_LIMITED",
        );
        entry.count++;
        loginAttempts.set(req.ip, entry);
      }
    });
    app.post(
      "/sessions/wallet/challenges",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["address"],
            properties: {
              address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            },
          },
        },
      },
      async (req: any) => walletAuth.challenge(req.body.address),
    );
    app.post(
      "/sessions/wallet",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["challengeId", "signature"],
            properties: {
              challengeId: { type: "string", minLength: 1, maxLength: 200 },
              signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
            },
          },
        },
      },
      async (req: any) =>
        walletAuth.finish(req.body.challengeId, req.body.signature),
    );
    app.post(
      "/sessions",
      {
        schema: {
          body: {
            type: "object",
            required: ["username", "password"],
            additionalProperties: false,
            properties: {
              username: { type: "string" },
              password: { type: "string", maxLength: 256 },
            },
          },
        },
      },
      async (req: any) => {
        const account = this.get(
          "SELECT * FROM accounts WHERE username=?",
          req.body.username,
        );
        if (
          !account ||
          !passwordMatches(req.body.password, account.password_hash)
        )
          throw new AppError(401, "LOGIN_FAILED", "게임 로그인을 확인하세요.");
        const token = opaque();
        this.run(
          "INSERT INTO sessions VALUES(?,?,?)",
          sha(token),
          account.id,
          Date.now() + 8 * 3600_000,
        );
        return { token };
      },
    );
    const accountOf = (req: any) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const account = token
        ? this.get(
            "SELECT a.* FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>?",
            sha(token),
            Date.now(),
          )
        : null;
      if (!account)
        throw new AppError(
          401,
          "GAME_LOGIN_REQUIRED",
          "게임 로그인이 필요합니다.",
        );
      return account;
    };
    app.post(
      "/link",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["code"],
            properties: { code: { type: "string", maxLength: 200 } },
          },
        },
      },
      async (req: any) => {
        const account = accountOf(req);
        const linked = await this.network.call("/player-links/exchange", {
          code: req.body.code,
          gamePlayerId: account.id,
        });
        this.run(
          "UPDATE accounts SET player_id=? WHERE id=?",
          linked.playerId,
          account.id,
        );
        return linked;
      },
    );
    app.get("/me", async (req) => {
      const a = accountOf(req);
      return {
        gameId: this.gameId,
        playerId: a.player_id,
        address: a.wallet ?? null,
        score: a.score,
        inventory: this.all(
          "SELECT sku,quantity FROM inventory WHERE account_id=?",
          a.id,
        ),
        ranking: this.all(
          "SELECT username,score FROM accounts ORDER BY score DESC",
        ),
        workerError: this.lastError,
      };
    });
    app.post(
      "/runs",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["score"],
            properties: { score: { type: "integer", minimum: 1, maximum: 50 } },
          },
        },
      },
      async (req: any) => {
        const a = accountOf(req);
        if (this.gameId !== "game-a")
          throw new AppError(422, "WRONG_GAME", "게임 A에서 플레이하세요.");
        this.transaction(() => {
          this.run(
            "INSERT INTO runs VALUES(?,?,?,?)",
            id("run"),
            a.id,
            req.body.score,
            Date.now(),
          );
          this.run(
            "UPDATE accounts SET score=MAX(score,?) WHERE id=?",
            req.body.score,
            a.id,
          );
        });
        return {
          score: this.get("SELECT score FROM accounts WHERE id=?", a.id).score,
        };
      },
    );
    app.post("/weekly-reward", async (req) => {
      const a = accountOf(req);
      if (
        this.gameId !== "game-a" ||
        (!a.wallet && !a.player_id) ||
        a.score < 1
      )
        throw new AppError(
          409,
          "NOT_ELIGIBLE",
          "지갑으로 로그인한 뒤 게임을 플레이하세요.",
        );
      const day = new Date();
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      const period = day.toISOString().slice(0, 10);
      const rewardRef = `${period}:${a.id}:weekly-ranking`;
      const existing = await this.network.call(
        `/games/${this.gameId}/rewards?rewardRef=${encodeURIComponent(rewardRef)}`,
      );
      if (existing.rewards.length) {
        const prior = existing.rewards[0];
        return {
          rewardId: prior.rewardId,
          operationId: prior.operationId,
          status: prior.status,
        };
      }
      return this.network.call(
        `/games/${this.gameId}/rewards`,
        {
          ...(a.wallet ? { recipient: a.wallet } : { playerId: a.player_id }),
          assetId: ASSET,
          amount: "10.000000",
          rewardRef,
          metadata: { period },
        },
        rewardRef,
      );
    });
    app.post(
      "/orders",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["orderId", "sku"],
            properties: {
              orderId: { type: "string", maxLength: 200, minLength: 1 },
              sku: { type: "string", enum: ["starter-pass"] },
            },
          },
        },
      },
      async (req: any) => {
        const a = accountOf(req);
        if (this.gameId !== "game-b" || (!a.wallet && !a.player_id))
          throw new AppError(
            409,
            "NOT_ELIGIBLE",
            "게임 B에 지갑으로 로그인하세요.",
          );
        const payload = {
          ...(a.wallet ? { payer: a.wallet } : { playerId: a.player_id }),
          orderId: req.body.orderId,
          assetId: ASSET,
          amount: "4.000000",
          item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
        };
        this.transaction(() => {
          const existing = this.get(
            "SELECT * FROM orders WHERE id=?",
            payload.orderId,
          );
          if (
            existing &&
            (existing.account_id !== a.id || existing.payload !== json(payload))
          )
            throw new AppError(409, "ORDER_CONFLICT", "주문 내용이 다릅니다.");
          this.run(
            "INSERT OR IGNORE INTO orders VALUES(?,?,?)",
            payload.orderId,
            a.id,
            json(payload),
          );
        });
        return this.network.call(
          `/games/${this.gameId}/payments`,
          payload,
          `order:${payload.orderId}`,
        );
      },
    );
    app.get("/orders/:orderId", async (req: any) => {
      const account = accountOf(req);
      const order = this.get(
        "SELECT * FROM orders WHERE id=? AND account_id=?",
        req.params.orderId,
        account.id,
      );
      requireThat(order, 404, "ORDER_NOT_FOUND");
      const list = await this.network.call(
        `/games/${this.gameId}/payments?orderId=${encodeURIComponent(order.id)}`,
      );
      const payment = list.payments.find(
        (pay: any) => pay.orderId === order.id,
      );
      requireThat(payment, 404, "PAYMENT_NOT_FOUND");
      return this.network.call(
        `/payments/${encodeURIComponent(payment.paymentId)}`,
      );
    });
    app.post(
      "/orders/:orderId/authorizations",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["signature"],
            properties: {
              signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
              permitSignature: {
                type: "string",
                pattern: "^0x[0-9a-fA-F]{130}$",
              },
              permitDeadline: { type: "integer", minimum: 1 },
            },
          },
        },
      },
      async (req: any) => {
        const account = accountOf(req);
        const order = this.get(
          "SELECT * FROM orders WHERE id=? AND account_id=?",
          req.params.orderId,
          account.id,
        );
        requireThat(order, 404, "ORDER_NOT_FOUND");
        // A retry of the original order recovers its payment without creating another order.
        const payment = await this.network.call(
          `/games/${this.gameId}/payments`,
          JSON.parse(order.payload),
          `order:${order.id}`,
        );
        return this.network.call(
          `/payments/${encodeURIComponent(payment.paymentId)}/authorizations`,
          req.body,
          `authorize:${payment.paymentId}:${sha(json(req.body))}`,
        );
      },
    );
    app.post("/bonus", async (req) => {
      const a = accountOf(req);
      if (
        this.gameId !== "game-b" ||
        !this.get(
          "SELECT payment_id FROM deliveries WHERE account_id=? AND status='DELIVERED'",
          a.id,
        )
      )
        throw new AppError(
          409,
          "NOT_ELIGIBLE",
          "구매를 완료한 뒤 받을 수 있습니다.",
        );
      return this.network.call(
        `/games/${this.gameId}/rewards`,
        {
          ...(a.wallet ? { recipient: a.wallet } : { playerId: a.player_id }),
          assetId: ASSET,
          amount: "1.000000",
          rewardRef: `first-purchase:${a.id}`,
        },
        `first-purchase:${a.id}`,
      );
    });
    return app;
  }
  close() {
    this.db.close();
  }
}
