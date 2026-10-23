import Fastify, { LogController } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  formatEther,
  getAddress,
  isAddress,
  parseEther,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { Store } from "./db.js";
import { Worker } from "./worker.js";
import { NATIVE_TRANSFER_GAS } from "./chain.js";
import {
  adminSetupCodeMatches,
  adminSetupPending,
  authenticate,
  createSession,
  isDisabled,
  login,
  type Principal,
} from "./auth.js";
import {
  WalletAuth,
  bindLoginWallet,
  loginWalletDetails,
  loginWallets,
  setLoginWalletAlias,
  walletOwner,
} from "./wallet-auth.js";
import { responseSchema } from "./schemas.js";
import {
  MONTHLY_LAST_DAY,
  firstRun,
  queueAllocation,
  runDueSchedules,
  type Cadence,
} from "./schedules.js";
import {
  ASSET,
  AppError,
  amount,
  display,
  id,
  opaque,
  sha,
  canonical,
  json,
  chainIdOf,
  orderHash,
  paymentTypes,
  budgetTypes,
  resolutionTypes,
  requireThat,
  type SigningRequest,
} from "./shared.js";

const string = { type: "string", minLength: 1, maxLength: 200 };
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const signature = { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" };
const amountSchema = {
  type: "string",
  maxLength: 85,
  pattern: "^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$",
};
const profileFields = {
  description: { type: "string", minLength: 1, maxLength: 500 },
  category: { type: "string", minLength: 1, maxLength: 40 },
  playUrl: { type: "string", minLength: 1, maxLength: 2048 },
};
const object = (
  properties: Record<string, any>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const walletRequest = (
  field: "recipient" | "payer",
  properties: Record<string, any>,
  required: string[],
) => ({
  ...object(
    {
      ...properties,
      [field]: {
        ...address,
        description: "Wallet address verified by the game's own login session.",
      },
      playerId: {
        ...string,
        deprecated: true,
        description:
          "Legacy account-link integration only; omit when using a wallet address.",
      },
    },
    required,
  ),
  oneOf: [{ required: [field] }, { required: ["playerId"] }],
});
const authorizationSchema = object(
  {
    signature,
    permitSignature: signature,
    permitDeadline: { type: "integer", minimum: 1 },
  },
  ["signature"],
);
const nonce = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

export async function createApi(
  store: Store,
  worker: Worker,
  options: {
    origin?: string;
    logger?: boolean;
    staticFiles?: boolean;
    // Tests and local tooling sign in with passwords; operating servers use wallets only.
    passwordLogin?: boolean;
    // How often recurring allocations are checked; 0 turns the timer off (tests).
    scheduleIntervalMs?: number;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const origin = options.origin ?? "http://localhost:3300";
  const walletAuth = new WalletAuth(store, origin);
  const authRequests = new Map<string, { count: number; until: number }>();
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.1",
      info: { title: "Metanomic Common Reward Network", version: "0.2.0" },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "Wallet/password login session or scoped game credential",
          },
        },
      },
    },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });
  app.setErrorHandler((error: any, req, reply) => {
    const status =
      error instanceof AppError ? error.status : error.validation ? 422 : 500;
    if (status === 500) req.log.error(error);
    reply.code(status).send({
      error: {
        code:
          error.code && error instanceof AppError
            ? error.code
            : status === 422
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR",
        message:
          status === 500 ? "요청 처리 중 오류가 발생했습니다." : error.message,
      },
    });
  });
  app.addHook("onRequest", async (req) => {
    // Bearer tokens avoid cookie CSRF; refuse cross-origin browser mutations as well.
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== origin
    )
      throw new AppError(403, "ORIGIN_DENIED", "허용되지 않은 화면입니다.");
    if (
      req.method === "POST" &&
      /^\/v1\/(sessions(?:\/|$)|account\/login-wallets|setup\/)/.test(req.url)
    ) {
      const now = Date.now();
      for (const [ip, entry] of authRequests)
        if (entry.until <= now) authRequests.delete(ip);
      const entry = authRequests.get(req.ip) ?? {
        count: 0,
        until: now + 60_000,
      };
      requireThat(
        entry.count < 60 &&
          (authRequests.has(req.ip) || authRequests.size < 5000),
        429,
        "AUTH_RATE_LIMITED",
        "로그인 요청이 많습니다. 잠시 후 다시 시도하세요.",
      );
      entry.count++;
      authRequests.set(req.ip, entry);
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:8545 http://localhost:8545 https://saigon-testnet.roninchain.com; img-src 'self' data:; frame-ancestors 'none'",
    );
  });
  const active = () => {
    const asset = store.get("SELECT * FROM assets WHERE id=?", ASSET);
    if (!asset)
      throw new AppError(503, "NO_DEPLOYMENT", "자산 배포가 필요합니다.");
    return worker.adapter(asset.active_deployment);
  };
  const game = (
    p: Principal,
    gameId: string,
    scope?: string,
    serverOnly = false,
  ) => {
    const g = store.get("SELECT * FROM games WHERE id=?", gameId);
    requireThat(g, 404, "GAME_NOT_FOUND");
    requireThat(
      (p.role === "admin" && !serverOnly) ||
        (p.role === "operator" && p.id === g.operator_id && !serverOnly) ||
        (p.role === "game" &&
          p.gameId === gameId &&
          (!scope || p.scopes?.includes(scope))),
      403,
      "GAME_ACCESS_DENIED",
    );
    return g;
  };
  const only = (p: Principal, role: string) =>
    requireThat(p.role === role, 403, "ROLE_DENIED");
  const profileOf = (body: any) => {
    const profile = {
      description: body.description?.trim() ?? "",
      category: body.category?.trim() ?? "기타",
      playUrl: body.playUrl?.trim() ?? "",
    };
    requireThat(
      body.name.trim() && profile.category,
      422,
      "INVALID_GAME_PROFILE",
    );
    if (body.playUrl !== undefined) {
      let url: URL | undefined;
      try {
        url = new URL(profile.playUrl);
      } catch {}
      requireThat(
        url &&
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password,
        422,
        "INVALID_PLAY_URL",
        "실행 주소는 http 또는 https 웹 주소여야 합니다.",
      );
    }
    return profile;
  };
  const catalogSql =
    "SELECT g.id,g.name,g.active,COALESCE(p.description,'') AS description,COALESCE(p.category,'기타') AS category,COALESCE(p.play_url,'') AS playUrl FROM games g LEFT JOIN game_profiles p ON p.game_id=g.id";
  const registrationView = (r: any) => ({
    ...JSON.parse(r.payload),
    registrationId: r.id,
    operatorId: r.operator_id,
    status: r.status,
    reviewNote: r.review_note,
    operationId: r.operation_id,
    error: r.operation_error ?? null,
    submittedAt: r.created_at,
  });
  const registrationById = (registrationId: string) =>
    registrationView(
      store.get(
        "SELECT r.*,o.error AS operation_error FROM game_registrations r LEFT JOIN operations o ON o.id=r.operation_id WHERE r.id=?",
        registrationId,
      ),
    );
  const registrations = (operatorId?: string) =>
    store
      .all(
        `SELECT r.*,o.error AS operation_error FROM game_registrations r LEFT JOIN operations o ON o.id=r.operation_id ${operatorId ? "WHERE r.operator_id=?" : ""} ORDER BY r.created_at DESC LIMIT 100`,
        ...(operatorId ? [operatorId] : []),
      )
      .map(registrationView);
  const ownsAddress = (p: Principal, value: unknown) =>
    typeof value === "string" &&
    loginWallets(store, p.id).some(
      (wallet) => wallet.toLowerCase() === value.toLowerCase(),
    );
  const ownsPayment = (p: Principal, pay: any) =>
    pay &&
    (pay.player_id === p.id || ownsAddress(p, JSON.parse(pay.payload).payer));
  const ownsReward = (p: Principal, reward: any) => {
    if (!reward) return false;
    const data = JSON.parse(reward.payload);
    return data.playerId === p.id || ownsAddress(p, data.recipient);
  };
  const paymentAccess = (p: Principal, paymentId: string) => {
    const pay = store.get("SELECT * FROM payments WHERE id=?", paymentId);
    requireThat(pay, 404, "PAYMENT_NOT_FOUND");
    if (!(p.role === "player" && ownsPayment(p, pay)))
      game(p, pay.game_id, "payments");
    return pay;
  };
  const key = (req: any) => String(req.headers["idempotency-key"] ?? "");
  const idem = (p: Principal, req: any, fn: () => any) =>
    store.idem(
      `${p.id}:${req.routeOptions.url}:${json(req.params)}`,
      key(req),
      req.body ?? {},
      fn,
    );
  const prior = (
    table: "rewards" | "payments" | "allocations",
    gameId: string,
    ref: string,
    body: unknown,
  ) => {
    const old = store.get(
      `SELECT * FROM ${table} WHERE game_id=? AND business_ref=?`,
      gameId,
      ref,
    );
    if (old)
      requireThat(
        old.content_hash === sha(canonical(body)),
        409,
        "BUSINESS_REFERENCE_CONFLICT",
      );
    return old;
  };
  const result = (resource: string, operationId: string, extra = {}) => ({
    ...extra,
    operationId,
    status:
      store.get("SELECT status FROM operations WHERE id=?", operationId)
        ?.status ?? "QUEUED",
  });
  const operationResult = (kind: string, resourceId: string, extra: any) => {
    const op = store.get(
      "SELECT * FROM operations WHERE kind=? AND resource_id=?",
      kind,
      resourceId,
    );
    return result(resourceId, op.id, extra);
  };
  const ensureAsset = (assetId: string) =>
    requireThat(assetId === ASSET, 422, "UNKNOWN_ASSET");
  const walletFor = (playerId: string, chainId: number) => {
    const w = store.get(
      "SELECT * FROM wallet_links WHERE player_id=? AND chain_id=?",
      playerId,
      chainId,
    );
    requireThat(w, 422, "WALLET_REQUIRED", "이용자의 지갑 연결이 필요합니다.");
    return w.address as Address;
  };
  const linked = (gameId: string, playerId: string) =>
    requireThat(
      store.get(
        "SELECT * FROM player_links WHERE game_id=? AND player_id=?",
        gameId,
        playerId,
      ),
      403,
      "PLAYER_NOT_LINKED",
    );
  // New integrations use the wallet verified by the game login. Legacy playerId
  // requests remain supported, with their original account-link checks.
  const gameWallet = (
    body: any,
    field: "recipient" | "payer",
    gameId: string,
    chainId: number,
  ) => {
    requireThat(
      Boolean(body[field]) !== Boolean(body.playerId),
      422,
      "WALLET_TARGET_REQUIRED",
      `지갑 ${field} 주소를 지정하세요. playerId와 함께 지정할 수 없습니다.`,
    );
    if (body.playerId) {
      linked(gameId, body.playerId);
      return walletFor(body.playerId, chainId);
    }
    const wallet = getAddress(body[field].toLowerCase());
    requireThat(
      wallet !== "0x0000000000000000000000000000000000000000",
      422,
      "INVALID_WALLET",
    );
    body[field] = wallet;
    return wallet;
  };
  const budgetView = async (deployment: string, gameId: string) => {
    const snapshot = await worker.refreshBudget(deployment, gameId);
    const reserved = worker.reserved(deployment, gameId);
    const incoming = worker.incoming(deployment, gameId, snapshot.block_number);
    const usable = BigInt(snapshot.amount) + incoming;
    return {
      assetId: ASSET,
      deploymentId: deployment,
      onchain: display(snapshot.amount),
      incoming: display(incoming),
      reserved: display(reserved),
      available: display(usable > reserved ? usable - reserved : 0n),
      blockNumber: snapshot.block_number,
      blockHash: snapshot.block_hash,
      finalized: true,
    };
  };
  const reserveCheck = (deployment: string, gameId: string, value: bigint) => {
    const snapshot = store.get(
      "SELECT * FROM budget_snapshots WHERE deployment_id=? AND game_id=?",
      deployment,
      gameId,
    );
    requireThat(
      snapshot &&
        BigInt(snapshot.amount) +
          worker.incoming(deployment, gameId, snapshot.block_number) -
          worker.reserved(deployment, gameId) >=
          value,
      409,
      "BUDGET_EXCEEDED",
    );
  };
  type Handler = (req: any, reply: any, principal: Principal) => any;
  const route = (
    method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
    path: string,
    description: string,
    body: any,
    handler: Handler,
    publicRoute = false,
  ) => {
    const params = Object.fromEntries(
      [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1], string]),
    );
    app.route({
      method,
      url: `/v1${path}`,
      schema: {
        summary: description,
        tags: [path.split("/")[1]],
        security: publicRoute ? [] : [{ bearerAuth: [] }],
        ...(Object.keys(params).length ? { params: object(params) } : {}),
        ...(body ? { body } : {}),
        ...(method !== "GET" &&
        ([
          "/games",
          "/allocations",
          "/allocation-schedules",
          "/issuances",
          "/relayer-fundings",
          "/game-registrations",
        ].includes(path) ||
          path.endsWith("/approvals") ||
          path.endsWith("/rejections") ||
          path.endsWith("/rewards") ||
          path.endsWith("/payments") ||
          path.endsWith("/authorizations") ||
          path.endsWith("/delivery-claims") ||
          path.endsWith("/fulfillments") ||
          path.endsWith("/refunds") ||
          path.endsWith("/resolutions") ||
          path.endsWith("/deposits") ||
          path.endsWith("/withdrawals") ||
          path.endsWith("/chain-state") ||
          method === "PATCH")
          ? {
              headers: {
                type: "object",
                required: ["idempotency-key"],
                properties: {
                  "idempotency-key": {
                    ...string,
                    description:
                      "Same key + same normalized body returns original result; different content returns 409.",
                  },
                },
              },
            }
          : {}),
        response: {
          200: responseSchema(method, path),
          202: responseSchema(method, path),
          ...Object.fromEntries(
            [401, 403, 404, 409, 422, 429, 500, 503].map((code) => [
              code,
              object({
                error: object({ code: string, message: { type: "string" } }),
              }),
            ]),
          ),
        },
      },
      handler: async (req, reply) =>
        handler(
          req,
          reply,
          publicRoute
            ? { id: "anonymous", role: "player" }
            : authenticate(store, req),
        ),
    });
  };
  route(
    "POST",
    "/sessions",
    "기존 계정의 아이디·비밀번호 로그인",
    object({
      username: string,
      password: { type: "string", minLength: 1, maxLength: 256 },
    }),
    (req) => {
      requireThat(
        options.passwordLogin ?? true,
        403,
        "PASSWORD_LOGIN_DISABLED",
        "비밀번호 로그인을 사용하지 않습니다. 지갑으로 로그인하세요.",
      );
      return login(store, req.body.username, req.body.password);
    },
    true,
  );
  route("DELETE", "/sessions/me", "로그아웃", null, (req) => {
    store.run(
      "DELETE FROM sessions WHERE token_hash=?",
      sha(req.headers.authorization.slice(7)),
    );
    return { loggedOut: true };
  });
  route("GET", "/me", "현재 계정", null, (_req, _reply, p) => ({ ...p }));
  const loginDeployment = (deploymentId: string) => {
    const adapter = worker.adapters.get(deploymentId);
    requireThat(
      adapter,
      422,
      "UNKNOWN_DEPLOYMENT",
      "사용할 지갑 네트워크를 확인하세요.",
    );
    return adapter!.deployment;
  };
  route(
    "POST",
    "/sessions/wallet/challenges",
    "지갑 로그인 메시지 발급 (SIWE)",
    object({ address, deploymentId: string }),
    (req) =>
      walletAuth.challenge(
        getAddress(req.body.address),
        loginDeployment(req.body.deploymentId),
      ),
    true,
  );
  route(
    "POST",
    "/sessions/wallet",
    "지갑 서명으로 로그인 또는 일반 이용자 가입",
    object({ challengeId: string, signature }),
    (req) => walletAuth.finish(req.body.challengeId, req.body.signature),
    true,
  );
  route(
    "GET",
    "/account/login-wallets",
    "현재 계정의 로그인 지갑",
    null,
    (_req, _reply, p) => {
      requireThat(p.role !== "game", 403, "ROLE_DENIED");
      const wallets = loginWalletDetails(store, p.id);
      return {
        addresses: wallets.map((wallet) => wallet.address),
        wallets,
        signingWallet: p.wallet ?? null,
      };
    },
  );
  route(
    "PUT",
    "/account/login-wallets/alias",
    "본인 등록 지갑의 사이트 별명 저장·수정·삭제 (null 또는 빈 문자열로 삭제)",
    object({
      address,
      alias: {
        description:
          "Metanomic display name only. Trim and collapse whitespace; at most 40 UTF-16 code units after normalization. null or blank deletes the alias.",
        anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }],
      },
    }),
    (req, _reply, p) => {
      requireThat(p.role !== "game", 403, "ROLE_DENIED");
      return setLoginWalletAlias(store, p.id, req.body.address, req.body.alias);
    },
  );
  route(
    "POST",
    "/account/login-wallets/challenges",
    "기존 계정에 로그인 지갑을 등록할 메시지 발급",
    object({ address, deploymentId: string }),
    (req, _reply, p) => {
      requireThat(p.role !== "game", 403, "ROLE_DENIED");
      return walletAuth.challenge(
        getAddress(req.body.address),
        loginDeployment(req.body.deploymentId),
        p.id,
      );
    },
  );
  route(
    "POST",
    "/account/login-wallets",
    "소유 확인 후 기존 계정에 로그인 지갑 등록",
    object({ challengeId: string, signature }),
    (req, _reply, p) => {
      requireThat(p.role !== "game", 403, "ROLE_DENIED");
      return walletAuth.finish(req.body.challengeId, req.body.signature, p.id);
    },
  );
  // First run: the admin account has only the server's contract key as a login
  // wallet, so the installer proves the printed setup code and signs with their own.
  const setupAdmin = () => {
    const admin = store.get(
      "SELECT * FROM accounts WHERE role='admin' ORDER BY rowid LIMIT 1",
    );
    requireThat(admin, 409, "ADMIN_ACCOUNT_MISSING");
    return admin;
  };
  const requireSetupCode = (code: string) =>
    requireThat(
      adminSetupCodeMatches(store, code),
      403,
      "SETUP_CODE_INVALID",
      "초기 설정 코드가 맞지 않거나 이미 사용되었습니다.",
    );
  route(
    "GET",
    "/setup",
    "초기 설정 상태 (관리자 로그인 지갑 등록 필요 여부)",
    null,
    () => ({ adminWalletSetup: adminSetupPending(store) }),
    true,
  );
  route(
    "POST",
    "/setup/admin-wallet/challenges",
    "초기 설정: 관리자 로그인 지갑 소유 확인 메시지 발급",
    object({
      address,
      deploymentId: string,
      setupCode: { type: "string", minLength: 1, maxLength: 200 },
    }),
    (req) => {
      requireSetupCode(req.body.setupCode);
      return walletAuth.challenge(
        getAddress(req.body.address),
        loginDeployment(req.body.deploymentId),
        setupAdmin().id,
        "admin-setup",
      );
    },
    true,
  );
  route(
    "POST",
    "/setup/admin-wallet",
    "초기 설정: 관리자 로그인 지갑 등록과 로그인",
    object({
      challengeId: string,
      signature,
      setupCode: { type: "string", minLength: 1, maxLength: 200 },
    }),
    (req) => {
      requireSetupCode(req.body.setupCode);
      const admin = setupAdmin();
      return walletAuth.proveWallet(
        "admin-setup",
        req.body.challengeId,
        req.body.signature,
        admin.id,
        (wallet) => {
          // Recheck inside the transaction so a code is consumed exactly once.
          requireSetupCode(req.body.setupCode);
          bindLoginWallet(store, admin.id, wallet);
          store.run("DELETE FROM admin_setup");
          store.audit(admin.id, "admin.setup-wallet", { address: wallet });
          return createSession(store, admin);
        },
      );
    },
    true,
  );
  const newGameId = () => {
    for (;;) {
      const candidate = `game-${randomBytes(4).toString("hex")}`;
      if (
        !store.get("SELECT 1 FROM games WHERE id=?", candidate) &&
        !store.get(
          "SELECT 1 FROM game_registrations WHERE game_id=?",
          candidate,
        )
      )
        return candidate;
    }
  };
  const applicationView = (row: any) => ({
    applicationId: row.id,
    accountId: row.account_id,
    wallet: row.wallet,
    displayName: row.display_name,
    contact: row.contact,
    introduction: row.introduction,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  });
  const applicationById = (applicationId: string) => {
    const row = store.get(
      "SELECT * FROM operator_applications WHERE id=?",
      applicationId,
    );
    requireThat(row, 404, "APPLICATION_NOT_FOUND");
    return row;
  };
  // An approval wallet becomes a contract operator address that cannot change later,
  // so it must belong only to the applicant and never to a network signer.
  const requireApplicantWallet = (accountId: string, wallet: string) => {
    const owner = walletOwner(store, wallet);
    requireThat(
      !owner || owner === accountId,
      409,
      "WALLET_ALREADY_LINKED",
      "다른 계정에 연결된 지갑입니다. 이 계정의 지갑으로 신청하세요.",
    );
    const reserved = [...worker.adapters.values()].some((a) =>
      [a.deployment.admin, a.deployment.relayer, a.deployment.settlement]
        .filter(Boolean)
        .some((x) => x.toLowerCase() === wallet.toLowerCase()),
    );
    requireThat(
      !reserved,
      409,
      "RESERVED_WALLET",
      "네트워크 운영용 지갑은 사용할 수 없습니다.",
    );
  };
  route(
    "POST",
    "/operator-applications/challenges",
    "게임 운영자 신청용 승인 지갑 소유 확인 메시지 발급",
    object({ address, deploymentId: string }),
    (req, _reply, p) => {
      only(p, "player");
      return walletAuth.challenge(
        getAddress(req.body.address),
        loginDeployment(req.body.deploymentId),
        p.id,
        "operator",
      );
    },
  );
  route(
    "POST",
    "/operator-applications",
    "게임 운영자 신청 (승인 지갑 서명 포함)",
    object({
      challengeId: string,
      signature,
      displayName: { type: "string", minLength: 1, maxLength: 80 },
      contact: { type: "string", minLength: 1, maxLength: 200 },
      introduction: { type: "string", minLength: 1, maxLength: 1000 },
    }),
    (req, _reply, p) => {
      only(p, "player");
      const fields = {
        displayName: req.body.displayName.trim(),
        contact: req.body.contact.trim(),
        introduction: req.body.introduction.trim(),
      };
      requireThat(
        fields.displayName && fields.contact && fields.introduction,
        422,
        "APPLICATION_FIELDS_REQUIRED",
        "운영사 이름, 연락처, 소개를 모두 입력하세요.",
      );
      return walletAuth.proveWallet(
        "operator",
        req.body.challengeId,
        req.body.signature,
        p.id,
        (wallet) => {
          requireThat(
            !store.get(
              "SELECT id FROM operator_applications WHERE account_id=? AND status='PENDING'",
              p.id,
            ),
            409,
            "APPLICATION_PENDING",
            "검토 중인 신청이 있습니다.",
          );
          requireApplicantWallet(p.id, wallet);
          const applicationId = id("operator-application");
          store.run(
            "INSERT INTO operator_applications VALUES(?,?,?,?,?,?,?,?,?,?)",
            applicationId,
            p.id,
            wallet,
            fields.displayName,
            fields.contact,
            fields.introduction,
            "PENDING",
            null,
            Date.now(),
            null,
          );
          store.audit(p.id, "operator.application.create", {
            applicationId,
            wallet,
            ...fields,
          });
          return applicationView(applicationById(applicationId));
        },
      );
    },
  );
  route(
    "GET",
    "/operator-applications",
    "게임 운영자 신청 조회 (관리자는 전체, 그 외 본인)",
    null,
    (_req, _reply, p) => {
      requireThat(p.role !== "game", 403, "ROLE_DENIED");
      return {
        applications: (p.role === "admin"
          ? store.all(
              "SELECT * FROM operator_applications ORDER BY created_at DESC LIMIT 100",
            )
          : store.all(
              "SELECT * FROM operator_applications WHERE account_id=? ORDER BY created_at DESC LIMIT 20",
              p.id,
            )
        ).map(applicationView),
      };
    },
  );
  route(
    "POST",
    "/operator-applications/:applicationId/approvals",
    "관리자 운영자 신청 승인 (계정을 운영자로 전환)",
    object({}),
    (req, _reply, p) => {
      only(p, "admin");
      return idem(p, req, () => {
        const row = applicationById(req.params.applicationId);
        if (row.status === "APPROVED") return applicationView(row);
        requireThat(row.status === "PENDING", 409, "APPLICATION_NOT_PENDING");
        const account = store.get(
          "SELECT * FROM accounts WHERE id=?",
          row.account_id,
        );
        requireThat(
          account?.role === "player" && !isDisabled(store, account.id),
          409,
          "ACCOUNT_NOT_ELIGIBLE",
          "이용자 계정만 운영자로 전환할 수 있습니다.",
        );
        requireApplicantWallet(account.id, row.wallet);
        store.run(
          "UPDATE accounts SET role='operator',wallet=? WHERE id=?",
          row.wallet,
          account.id,
        );
        store.run(
          "UPDATE operator_applications SET status='APPROVED',review_note=NULL,reviewed_at=? WHERE id=?",
          Date.now(),
          row.id,
        );
        store.audit(p.id, "operator.application.approve", {
          applicationId: row.id,
          accountId: account.id,
          wallet: row.wallet,
        });
        return applicationView(applicationById(row.id));
      });
    },
  );
  route(
    "POST",
    "/operator-applications/:applicationId/rejections",
    "관리자 운영자 신청 반려",
    object({ reason: { type: "string", minLength: 1, maxLength: 500 } }),
    (req, _reply, p) => {
      only(p, "admin");
      return idem(p, req, () => {
        const row = applicationById(req.params.applicationId);
        requireThat(row.status === "PENDING", 409, "APPLICATION_NOT_PENDING");
        const reason = req.body.reason.trim();
        requireThat(reason, 422, "REVIEW_REASON_REQUIRED");
        store.run(
          "UPDATE operator_applications SET status='REJECTED',review_note=?,reviewed_at=? WHERE id=?",
          reason,
          Date.now(),
          row.id,
        );
        store.audit(p.id, "operator.application.reject", {
          applicationId: row.id,
          reason,
        });
        return applicationView(applicationById(row.id));
      });
    },
  );
  route(
    "GET",
    "/assets",
    "자산과 배포 조회",
    null,
    () => ({
      assets: store.all("SELECT * FROM assets").map((a) => ({
        assetId: a.id,
        decimals: a.decimals,
        activeDeploymentId: a.active_deployment,
        deployments: [...worker.adapters.values()].map((a) => a.deployment),
      })),
    }),
    true,
  );
  route(
    "GET",
    "/games",
    "참여 게임 조회",
    null,
    () => ({
      games: store.all(catalogSql + " WHERE g.active=1 ORDER BY g.rowid"),
    }),
    true,
  );
  route(
    "GET",
    "/operator/games",
    "본인 게임 관리 목록",
    null,
    (_req, _reply, p) => {
      only(p, "operator");
      return {
        games: store.all(
          catalogSql +
            " WHERE g.operator_id=? AND NOT EXISTS (SELECT 1 FROM game_registrations r WHERE r.game_id=g.id AND r.status!='APPROVED') ORDER BY g.rowid",
          p.id,
        ),
      };
    },
  );
  route(
    "GET",
    "/game-registrations",
    "운영자 본인 신청 또는 관리자 전체 신청",
    null,
    (_req, _reply, p) => {
      requireThat(["operator", "admin"].includes(p.role), 403, "ROLE_DENIED");
      return {
        registrations: registrations(p.role === "operator" ? p.id : undefined),
      };
    },
  );
  route(
    "POST",
    "/game-registrations",
    "운영자 게임 등록 신청 (게임 ID는 서버가 발급, 반려 후 재신청 때만 지정)",
    object(
      {
        gameId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,63}$" },
        name: { type: "string", minLength: 1, maxLength: 80 },
        ...profileFields,
      },
      ["name", ...Object.keys(profileFields)],
    ),
    (req, reply, p) => {
      only(p, "operator");
      requireThat(p.wallet, 422, "OPERATOR_WALLET_REQUIRED");
      const profile = profileOf(req.body);
      requireThat(profile.description, 422, "INVALID_GAME_PROFILE");
      const response = idem(p, req, () => {
        // Operators do not invent IDs; a resubmission names its rejected one.
        const payload = {
          ...req.body,
          gameId: req.body.gameId ?? newGameId(),
          name: req.body.name.trim(),
          ...profile,
        };
        const prior = store.get(
          "SELECT * FROM game_registrations WHERE game_id=?",
          payload.gameId,
        );
        if (prior && prior.status !== "REJECTED") {
          requireThat(
            prior.operator_id === p.id &&
              canonical(JSON.parse(prior.payload)) === canonical(payload),
            409,
            "GAME_REGISTRATION_CONFLICT",
            "같은 게임 ID의 신청이 이미 있습니다.",
          );
          return registrationById(prior.id);
        }
        requireThat(
          !store.get("SELECT id FROM games WHERE id=?", payload.gameId) &&
            (!prior || prior.operator_id === p.id),
          409,
          "GAME_EXISTS",
        );
        const registrationId = prior?.id ?? id("registration");
        store.run(
          "INSERT INTO game_registrations VALUES(?,?,?,?, 'PENDING',NULL,NULL,?) ON CONFLICT(game_id) DO UPDATE SET payload=excluded.payload,status='PENDING',review_note=NULL,created_at=excluded.created_at",
          registrationId,
          payload.gameId,
          p.id,
          json(payload),
          Date.now(),
        );
        store.audit(p.id, "game.registration.submit", {
          registrationId,
          ...payload,
        });
        return registrationById(registrationId);
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "POST",
    "/game-registrations/:registrationId/approvals",
    "관리자 승인과 계약 등록 접수",
    object({}),
    async (req, reply, p) => {
      only(p, "admin");
      const a = active();
      await a.finalBlock();
      const response = idem(p, req, () => {
        const r = store.get(
          "SELECT * FROM game_registrations WHERE id=?",
          req.params.registrationId,
        );
        requireThat(r, 404, "REGISTRATION_NOT_FOUND");
        if (["REGISTERING", "APPROVED"].includes(r.status))
          return result(r.game_id, r.operation_id, {
            registrationId: r.id,
            gameId: r.game_id,
          });
        requireThat(
          ["PENDING", "FAILED"].includes(r.status),
          409,
          "REGISTRATION_NOT_PENDING",
        );
        const operator = store.get(
          "SELECT * FROM accounts WHERE id=? AND role='operator'",
          r.operator_id,
        );
        requireThat(operator?.wallet, 422, "OPERATOR_WALLET_REQUIRED");
        const payload = JSON.parse(r.payload);
        const old = store.get("SELECT * FROM games WHERE id=?", r.game_id);
        requireThat(
          !old ||
            (r.status === "FAILED" &&
              old.operator_id === r.operator_id &&
              !old.active),
          409,
          "GAME_EXISTS",
        );
        store.run(
          "INSERT INTO games VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
          r.game_id,
          payload.name,
          operator.id,
          operator.wallet,
        );
        store.run(
          "INSERT INTO game_profiles VALUES(?,?,?,?) ON CONFLICT(game_id) DO UPDATE SET description=excluded.description,category=excluded.category,play_url=excluded.play_url",
          r.game_id,
          payload.description,
          payload.category,
          payload.playUrl,
        );
        const op = worker.queue(
          "registerGame",
          id("registration-attempt"),
          r.game_id,
          a.deployment.id,
          "admin",
          [chainIdOf(r.game_id), operator.wallet, true],
        );
        store.run(
          "UPDATE game_registrations SET status='REGISTERING',operation_id=?,review_note=NULL WHERE id=?",
          op,
          r.id,
        );
        store.audit(p.id, "game.registration.approve", {
          registrationId: r.id,
          gameId: r.game_id,
          operationId: op,
        });
        return result(r.game_id, op, {
          registrationId: r.id,
          gameId: r.game_id,
        });
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "POST",
    "/game-registrations/:registrationId/rejections",
    "관리자 등록 반려",
    object({ reason: { type: "string", minLength: 1, maxLength: 500 } }),
    (req, _reply, p) => {
      only(p, "admin");
      return idem(p, req, () => {
        const r = store.get(
          "SELECT * FROM game_registrations WHERE id=?",
          req.params.registrationId,
        );
        requireThat(r, 404, "REGISTRATION_NOT_FOUND");
        requireThat(r.status === "PENDING", 409, "REGISTRATION_NOT_PENDING");
        requireThat(req.body.reason.trim(), 422, "REVIEW_REASON_REQUIRED");
        store.run(
          "UPDATE game_registrations SET status='REJECTED',review_note=? WHERE id=?",
          req.body.reason.trim(),
          r.id,
        );
        store.audit(p.id, "game.registration.reject", {
          registrationId: r.id,
          reason: req.body.reason.trim(),
        });
        return registrationById(r.id);
      });
    },
  );
  route(
    "POST",
    "/games",
    "관리자 게임 등록",
    object(
      { gameId: string, name: string, operatorId: string, ...profileFields },
      ["gameId", "name", "operatorId"],
    ),
    async (req, reply, p) => {
      only(p, "admin");
      const profile = profileOf(req.body);
      const a = active();
      await a.finalBlock();
      const operator = store.get(
        "SELECT * FROM accounts WHERE id=? AND role='operator'",
        req.body.operatorId,
      );
      requireThat(operator?.wallet, 422, "OPERATOR_WALLET_REQUIRED");
      const response = idem(p, req, () => {
        requireThat(
          !store.get("SELECT id FROM games WHERE id=?", req.body.gameId),
          409,
          "GAME_EXISTS",
        );
        requireThat(
          !store.get(
            "SELECT id FROM game_registrations WHERE game_id=? AND status!='REJECTED'",
            req.body.gameId,
          ),
          409,
          "GAME_REGISTRATION_CONFLICT",
        );
        store.run(
          "INSERT INTO games VALUES(?,?,?,?,0)",
          req.body.gameId,
          req.body.name,
          operator.id,
          operator.wallet,
        );
        store.run(
          "INSERT INTO game_profiles VALUES(?,?,?,?)",
          req.body.gameId,
          profile.description,
          profile.category,
          profile.playUrl,
        );
        const op = worker.queue(
          "registerGame",
          req.body.gameId,
          req.body.gameId,
          a.deployment.id,
          "admin",
          [chainIdOf(req.body.gameId), operator.wallet, true],
        );
        store.audit(p.id, "game.register", req.body);
        return result(req.body.gameId, op, { gameId: req.body.gameId });
      });
      return reply.code(202).send(response);
    },
  );
  // Switching a game on or off is a portal decision applied at once. The
  // contract's active flag is set when the game is registered and stays as is;
  // the API refuses new rewards and payments for games switched off here.
  route(
    "PATCH",
    "/games/:gameId",
    "관리자 게임 켜기·끄기 (즉시 반영, 블록체인 거래 없음)",
    object({ active: { type: "boolean" } }, ["active"]),
    async (req, _reply, p) => {
      only(p, "admin");
      const g = game(p, req.params.gameId);
      const registration = store.get(
        "SELECT status FROM game_registrations WHERE game_id=?",
        g.id,
      );
      requireThat(
        !registration || registration.status === "APPROVED",
        409,
        "GAME_REGISTRATION_PENDING",
      );
      if (req.body.active) {
        const [, onchainActive] = await active().read("games", [
          chainIdOf(g.id),
        ]);
        requireThat(
          onchainActive,
          409,
          "GAME_INACTIVE_ONCHAIN",
          "계약에서 운영 중지된 게임은 다시 켤 수 없습니다.",
        );
      }
      return idem(p, req, () => {
        store.run(
          "UPDATE games SET active=? WHERE id=?",
          req.body.active ? 1 : 0,
          g.id,
        );
        store.audit(p.id, "game.active", {
          gameId: g.id,
          active: req.body.active,
        });
        return { gameId: g.id, active: req.body.active };
      });
    },
  );
  // Records a stop or resume in the contract. Separate from the portal switch:
  // a recorded stop makes the contract refuse new payments, rewards and
  // allocations even if the server misbehaves; once final it also switches the
  // portal off. A recorded resume never switches the portal on by itself.
  route(
    "POST",
    "/games/:gameId/chain-state",
    "관리자 게임 중지·재개를 블록체인 계약에 기록",
    object({ active: { type: "boolean" } }, ["active"]),
    async (req, reply, p) => {
      only(p, "admin");
      const g = game(p, req.params.gameId);
      const a = active();
      requireThat(a.wallets.admin, 503, "SIGNER_UNAVAILABLE");
      await a.finalBlock();
      const response = idem(p, req, () => {
        requireThat(
          !store.get(
            "SELECT 1 FROM operations WHERE kind='registerGame' AND game_id=? AND status NOT IN ('FINALIZED','FAILED')",
            g.id,
          ),
          409,
          "CHAIN_STATE_PENDING",
          "이 게임의 블록체인 기록이 처리 중입니다. 끝난 뒤 다시 시도하세요.",
        );
        const ref = id("chain-state");
        const op = worker.queue(
          "registerGame",
          ref,
          g.id,
          a.deployment.id,
          "admin",
          [chainIdOf(g.id), g.operator_wallet, req.body.active],
        );
        store.audit(p.id, "game.chain-state", {
          gameId: g.id,
          active: req.body.active,
          operationId: op,
        });
        return result(ref, op, { gameId: g.id });
      });
      return reply.code(202).send(response);
    },
  );
  // Forgets a switched-off game in the portal. The contract keeps its entry and
  // budget ledger; money history (payments, rewards) stays for accounting.
  route(
    "DELETE",
    "/games/:gameId",
    "관리자 게임 삭제 (포털에서 제거, 거래 기록은 유지)",
    null,
    (req, _reply, p) => {
      only(p, "admin");
      return store.transaction(() => {
        const g = store.get(
          "SELECT * FROM games WHERE id=?",
          req.params.gameId,
        );
        requireThat(g, 404, "GAME_NOT_FOUND");
        requireThat(!g.active, 409, "GAME_ACTIVE", "먼저 게임을 끄세요.");
        requireThat(
          !store.get(
            "SELECT 1 FROM payments WHERE game_id=? AND status IN ('CREATED','PROCESSING','PAID','DELIVERY_CLAIMED')",
            g.id,
          ),
          409,
          "GAME_HAS_OPEN_PAYMENTS",
          "끝나지 않은 결제가 있습니다. 결제가 완료·환불·만료된 뒤 삭제하세요.",
        );
        requireThat(
          !store.get(
            "SELECT 1 FROM operations WHERE game_id=? AND status NOT IN ('FINALIZED','FAILED')",
            g.id,
          ),
          409,
          "GAME_HAS_PENDING_OPERATIONS",
          "처리 중인 거래가 있습니다. 끝난 뒤 삭제하세요.",
        );
        for (const table of [
          "player_links",
          "game_credentials",
          "game_profiles",
          "game_registrations",
          "budget_snapshots",
          "allocation_schedules",
        ])
          store.run(`DELETE FROM ${table} WHERE game_id=?`, g.id);
        store.run("DELETE FROM games WHERE id=?", g.id);
        store.audit(p.id, "game.delete", {
          gameId: g.id,
          name: g.name,
          operatorId: g.operator_id,
        });
        return { gameId: g.id, deleted: true };
      });
    },
  );
  route(
    "POST",
    "/games/:gameId/credentials",
    "운영자 게임 자격증명 발급",
    object(
      {
        label: {
          type: "string",
          minLength: 1,
          maxLength: 60,
          description: "용도를 기억하기 위한 이름 (예: 운영 서버, 스테이징)",
        },
        scopes: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["links", "rewards", "payments", "events", "budget"],
          },
        },
      },
      ["label", "scopes"],
    ),
    (req, _reply, p) => {
      const g = game(p, req.params.gameId);
      requireThat(p.role !== "game", 403, "OPERATOR_REQUIRED");
      const registration = store.get(
        "SELECT status FROM game_registrations WHERE game_id=?",
        g.id,
      );
      requireThat(
        !registration || registration.status === "APPROVED",
        409,
        "GAME_REGISTRATION_PENDING",
      );
      const label = req.body.label.trim();
      requireThat(label, 422, "LABEL_REQUIRED");
      const token = opaque(),
        credentialId = id("credential");
      store.transaction(() => {
        store.run(
          "INSERT INTO game_credentials(id,game_id,token_hash,scopes,label,created_at) VALUES(?,?,?,?,?,?)",
          credentialId,
          g.id,
          sha(token),
          json(req.body.scopes),
          label,
          Date.now(),
        );
        store.audit(p.id, "credential.issue", {
          gameId: g.id,
          credentialId,
          label,
          scopes: req.body.scopes,
        });
      });
      return { credentialId, label, token, scopes: req.body.scopes };
    },
  );
  route(
    "GET",
    "/games/:gameId/credentials",
    "운영자 자격증명 목록 (비밀값 제외)",
    null,
    (req, _reply, p) => {
      game(p, req.params.gameId);
      requireThat(p.role !== "game", 403, "OPERATOR_REQUIRED");
      return {
        credentials: store
          .all(
            "SELECT id,label,scopes,revoked,created_at FROM game_credentials WHERE game_id=? AND revoked=0 ORDER BY rowid DESC",
            req.params.gameId,
          )
          .map(({ created_at, ...row }) => ({
            ...row,
            scopes: JSON.parse(row.scopes),
            createdAt: created_at,
          })),
      };
    },
  );
  route(
    "DELETE",
    "/games/:gameId/credentials/:credentialId",
    "게임 자격증명 폐기",
    null,
    (req, _reply, p) => {
      game(p, req.params.gameId);
      requireThat(p.role !== "game", 403, "OPERATOR_REQUIRED");
      store.transaction(() => {
        store.run(
          // A revoked key is simply forgotten; the audit log keeps the record.
          "DELETE FROM game_credentials WHERE id=? AND game_id=?",
          req.params.credentialId,
          req.params.gameId,
        );
        store.audit(p.id, "credential.revoke", req.params);
      });
      return { revoked: true };
    },
  );
  route(
    "POST",
    "/player-links/codes",
    "대상 게임용 일회용 계정 연결 코드 발급",
    object({ gameId: string }),
    (req, _reply, p) => {
      only(p, "player");
      requireThat(
        store.get(
          "SELECT id FROM games WHERE id=? AND active=1",
          req.body.gameId,
        ),
        422,
        "GAME_INACTIVE",
      );
      const code = opaque();
      store.run(
        "INSERT INTO challenges VALUES(?,?,?,?,?,?,0)",
        sha(code),
        "player-link",
        p.id,
        req.body.gameId,
        "{}",
        Date.now() + 300_000,
      );
      return { code, gameId: req.body.gameId, expiresIn: 300 };
    },
  );
  route(
    "POST",
    "/player-links/exchange",
    "게임 서버에서 연결 코드 교환",
    object({ code: string, gamePlayerId: string }),
    (req, _reply, p) => {
      only(p, "game");
      game(p, p.gameId!, "links", true);
      return store.transaction(() => {
        const code = store.get(
          "SELECT * FROM challenges WHERE id=? AND kind='player-link' AND game_id=? AND used=0 AND expires_at>?",
          sha(req.body.code),
          p.gameId,
          Date.now(),
        );
        requireThat(code, 422, "INVALID_LINK_CODE");
        const existing = store.get(
          "SELECT * FROM player_links WHERE game_id=? AND (game_player_id=? OR player_id=?)",
          p.gameId,
          req.body.gamePlayerId,
          code.owner_id,
        );
        requireThat(
          !existing ||
            (existing.player_id === code.owner_id &&
              existing.game_player_id === req.body.gamePlayerId),
          409,
          "ACCOUNT_ALREADY_LINKED",
        );
        store.run(
          "INSERT OR IGNORE INTO player_links VALUES(?,?,?)",
          p.gameId,
          req.body.gamePlayerId,
          code.owner_id,
        );
        store.run("UPDATE challenges SET used=1 WHERE id=?", code.id);
        return { playerId: code.owner_id, gamePlayerId: req.body.gamePlayerId };
      });
    },
  );
  route(
    "POST",
    "/wallet-links/challenges",
    "지갑 소유 확인 메시지 발급",
    object({ address, deploymentId: string }),
    (req, _reply, p) => {
      only(p, "player");
      const a = worker.adapter(req.body.deploymentId);
      const challengeId = id("wallet-proof");
      const expiresAt = Date.now() + 300_000;
      const message = a.prepareWalletProof({
        origin,
        playerId: p.id,
        address: getAddress(req.body.address),
        nonce: opaque(),
        expiresAt,
      });
      store.run(
        "INSERT INTO challenges VALUES(?,?,?,?,?,?,0)",
        challengeId,
        "wallet",
        p.id,
        null,
        json({
          address: getAddress(req.body.address),
          chainId: a.deployment.chainId,
          deploymentId: a.deployment.id,
          message,
        }),
        expiresAt,
      );
      return { challengeId, message, expiresAt };
    },
  );
  route(
    "POST",
    "/wallet-links",
    "서명 검증 후 지갑 연결",
    object({ challengeId: string, signature }),
    async (req, _reply, p) => {
      only(p, "player");
      const challenge = store.get(
        "SELECT * FROM challenges WHERE id=? AND owner_id=? AND kind='wallet' AND used=0 AND expires_at>?",
        req.body.challengeId,
        p.id,
        Date.now(),
      );
      requireThat(challenge, 422, "INVALID_CHALLENGE");
      const data = JSON.parse(challenge.payload);
      requireThat(
        await worker
          .adapter(data.deploymentId)
          .verifyWalletProof(data.message, req.body.signature, data.address),
        422,
        "INVALID_SIGNATURE",
      );
      return store.transaction(() => {
        requireThat(
          store.get(
            "SELECT used FROM challenges WHERE id=? AND expires_at>?",
            challenge.id,
            Date.now(),
          )?.used === 0,
          409,
          "CHALLENGE_USED",
        );
        const existing = store.get(
          "SELECT player_id FROM wallet_links WHERE chain_id=? AND address=?",
          data.chainId,
          data.address,
        );
        requireThat(
          !existing || existing.player_id === p.id,
          409,
          "WALLET_ALREADY_LINKED",
        );
        bindLoginWallet(store, p.id, data.address);
        store.run(
          "INSERT INTO wallet_links VALUES(?,?,?) ON CONFLICT(player_id,chain_id) DO UPDATE SET address=excluded.address",
          p.id,
          data.chainId,
          data.address,
        );
        store.run("UPDATE challenges SET used=1 WHERE id=?", challenge.id);
        return { address: data.address, chainId: data.chainId };
      });
    },
  );
  route(
    "GET",
    "/players/me/balances",
    "본인 배포별 확정 잔액",
    null,
    async (_req, _reply, p) => {
      only(p, "player");
      return {
        balances: await Promise.all(
          [...worker.adapters.values()].map(async (a) => {
            const w = store.get(
              "SELECT * FROM wallet_links WHERE player_id=? AND chain_id=?",
              p.id,
              a.deployment.chainId,
            );
            if (!w)
              return {
                assetId: ASSET,
                deploymentId: a.deployment.id,
                walletRequired: true,
              };
            const block = await a.finalBlock();
            return {
              assetId: ASSET,
              deploymentId: a.deployment.id,
              address: w.address,
              amount: display(await a.getBalance(w.address, block.number)),
              blockNumber: block.number.toString(),
              finalized: true,
            };
          }),
        ),
      };
    },
  );
  route(
    "GET",
    "/players/me/activity",
    "본인 보상과 주문",
    null,
    (_req, _reply, p) => {
      only(p, "player");
      const wallets = json(
        loginWallets(store, p.id).map((wallet) => wallet.toLowerCase()),
      );
      return {
        links: store.all(
          "SELECT game_id AS gameId FROM player_links WHERE player_id=? ORDER BY game_id",
          p.id,
        ),
        payments: store
          .all(
            "SELECT id,game_id,status,payload FROM payments WHERE player_id=? OR lower(json_extract(payload,'$.payer')) IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT 100",
            p.id,
            wallets,
          )
          .map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
        rewards: store
          .all(
            "SELECT * FROM rewards WHERE json_extract(payload,'$.playerId')=? OR lower(json_extract(payload,'$.recipient')) IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 100",
            p.id,
            wallets,
          )
          .map((r) => ({
            rewardId: r.id,
            gameId: r.game_id,
            ...JSON.parse(r.payload),
            operation: store.get(
              "SELECT id,status FROM operations WHERE resource_id=?",
              r.id,
            ),
          })),
      };
    },
  );
  route(
    "GET",
    "/games/:gameId/budget",
    "게임 예산·예약·기준 블록",
    null,
    async (req, _reply, p) => {
      game(p, req.params.gameId, "budget");
      const a = req.query.deploymentId
        ? worker.adapter(req.query.deploymentId)
        : active();
      return budgetView(a.deployment.id, req.params.gameId);
    },
  );
  route(
    "POST",
    "/allocations",
    "관리자 예산 배분",
    object(
      {
        gameId: string,
        // Optional business reference for scripted, resumable runs: one
        // allocation per period/type/ref. Without it every request allocates.
        period: string,
        allocationType: { type: "string", enum: ["weekly", "additional"] },
        allocationRef: string,
        assetId: string,
        amount: amountSchema,
      },
      ["gameId", "assetId", "amount"],
    ),
    async (req, reply, p) => {
      only(p, "admin");
      const a = active();
      ensureAsset(req.body.assetId);
      const g = game(p, req.body.gameId);
      requireThat(g.active, 409, "GAME_INACTIVE");
      const value = amount(req.body.amount);
      await a.finalBlock();
      const type = req.body.allocationType ?? "weekly";
      if (type === "additional")
        requireThat(
          req.body.allocationRef,
          422,
          "ALLOCATION_REFERENCE_REQUIRED",
        );
      requireThat(
        req.body.period || !req.body.allocationType,
        422,
        "ALLOCATION_PERIOD_REQUIRED",
      );
      const response = idem(p, req, () => {
        const ref = req.body.period
          ? `${req.body.period}:${type}:${type === "weekly" ? "base" : req.body.allocationRef}`
          : `once:${id("ref")}`;
        const old = prior("allocations", g.id, ref, req.body);
        if (old)
          return operationResult("allocate", old.id, { allocationId: old.id });
        const queued = queueAllocation(store, worker, {
          actorId: p.id,
          gameId: g.id,
          deploymentId: a.deployment.id,
          value,
          ref,
          body: req.body,
        });
        return result(queued.allocationId, queued.operationId, {
          allocationId: queued.allocationId,
        });
      });
      return reply.code(202).send(response);
    },
  );
  const scheduleView = (s: any) => ({
    scheduleId: s.id,
    gameId: s.game_id,
    gameName:
      store.get("SELECT name FROM games WHERE id=?", s.game_id)?.name ?? null,
    amount: display(s.amount),
    cadence: s.cadence,
    day: s.day,
    active: !!s.active,
    nextRunAt: s.next_run_at,
    lastRunAt: s.last_run_at,
    lastAllocationId: s.last_allocation_id,
    lastError: s.last_error,
    createdAt: s.created_at,
  });
  const scheduleOf = (scheduleId: string) => {
    const s = store.get(
      "SELECT * FROM allocation_schedules WHERE id=?",
      scheduleId,
    );
    requireThat(s, 404, "SCHEDULE_NOT_FOUND");
    return s;
  };
  route(
    "GET",
    "/allocation-schedules",
    "반복 예산 배분 목록",
    null,
    (_req, _reply, p) => {
      only(p, "admin");
      return {
        schedules: store
          .all("SELECT * FROM allocation_schedules ORDER BY created_at DESC")
          .map(scheduleView),
      };
    },
  );
  route(
    "POST",
    "/allocation-schedules",
    "반복 예산 배분 등록 (매주 요일 또는 매월 날짜)",
    object({
      gameId: string,
      assetId: string,
      amount: amountSchema,
      cadence: { type: "string", enum: ["weekly", "monthly"] },
      // weekly: 0(일)~6(토), monthly: 1~28
      day: { type: "integer", minimum: 0, maximum: MONTHLY_LAST_DAY },
    }),
    (req, _reply, p) => {
      only(p, "admin");
      ensureAsset(req.body.assetId);
      const g = game(p, req.body.gameId);
      requireThat(g.active, 409, "GAME_INACTIVE");
      const value = amount(req.body.amount);
      const cadence = req.body.cadence as Cadence;
      const day = req.body.day;
      requireThat(
        cadence === "weekly" ? day <= 6 : day >= 1,
        422,
        "INVALID_SCHEDULE_DAY",
      );
      return idem(p, req, () => {
        const scheduleId = id("schedule");
        const now = Date.now();
        store.run(
          "INSERT INTO allocation_schedules(id,game_id,amount,cadence,day,active,next_run_at,created_by,created_at) VALUES(?,?,?,?,?,1,?,?,?)",
          scheduleId,
          g.id,
          value.toString(),
          cadence,
          day,
          firstRun(cadence, day, now),
          p.id,
          now,
        );
        store.audit(p.id, "allocation.schedule.create", {
          scheduleId,
          ...req.body,
        });
        return scheduleView(scheduleOf(scheduleId));
      });
    },
  );
  route(
    "PATCH",
    "/allocation-schedules/:scheduleId",
    "반복 예산 배분 일시 중지·재개",
    object({ active: { type: "boolean" } }),
    (req, _reply, p) => {
      only(p, "admin");
      const s = scheduleOf(req.params.scheduleId);
      store.transaction(() => {
        // Resuming starts from the next matching day; missed periods are not paid.
        store.run(
          "UPDATE allocation_schedules SET active=?,next_run_at=?,last_error=NULL WHERE id=?",
          req.body.active ? 1 : 0,
          req.body.active
            ? firstRun(s.cadence, s.day, Date.now())
            : s.next_run_at,
          s.id,
        );
        store.audit(p.id, "allocation.schedule.update", {
          scheduleId: s.id,
          active: req.body.active,
        });
      });
      return scheduleView(scheduleOf(s.id));
    },
  );
  route(
    "DELETE",
    "/allocation-schedules/:scheduleId",
    "반복 예산 배분 삭제 (이미 보낸 배분은 그대로)",
    null,
    (req, _reply, p) => {
      only(p, "admin");
      const s = scheduleOf(req.params.scheduleId);
      store.transaction(() => {
        store.run("DELETE FROM allocation_schedules WHERE id=?", s.id);
        store.audit(p.id, "allocation.schedule.delete", {
          scheduleId: s.id,
          gameId: s.game_id,
        });
      });
      return { scheduleId: s.id, deleted: true };
    },
  );
  const runSchedules = (now = Date.now()) => {
    const asset = store.get("SELECT * FROM assets WHERE id=?", ASSET);
    return runDueSchedules(store, worker, asset?.active_deployment, ASSET, now);
  };
  if (options.scheduleIntervalMs !== 0) {
    const timer = setInterval(() => {
      try {
        runSchedules();
      } catch (e: any) {
        app.log.error({ err: e }, "allocation schedule run failed");
      }
    }, options.scheduleIntervalMs ?? 60_000);
    app.addHook("onClose", async () => clearInterval(timer));
  }
  app.decorate("runSchedules", runSchedules);
  // Manual relayer top-up; the admin wallet always keeps its own gas reserve.
  const DEFAULT_ADMIN_MIN_WEI = parseEther("0.5");
  route(
    "POST",
    "/relayer-fundings",
    "관리자 지갑에서 중계 지갑으로 RON 충전",
    object({ amount: { type: "string", minLength: 1, maxLength: 40 } }, [
      "amount",
    ]),
    async (req, reply, p) => {
      only(p, "admin");
      requireThat(
        /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(req.body.amount),
        422,
        "INVALID_AMOUNT",
        "RON 수량을 숫자로 입력하세요 (소수점 18자리까지).",
      );
      const value = parseEther(req.body.amount);
      requireThat(
        value > 0n,
        422,
        "INVALID_AMOUNT",
        "0보다 큰 수량을 입력하세요.",
      );
      const a = active();
      requireThat(a.wallets.admin, 503, "SIGNER_UNAVAILABLE");
      const [admin, gasPrice] = await Promise.all([
        a.publicClient.getBalance({ address: a.deployment.admin }),
        a.publicClient.getGasPrice(),
      ]);
      const reserve = worker.funding?.adminMinWei ?? DEFAULT_ADMIN_MIN_WEI;
      const sendable = admin - reserve - gasPrice * NATIVE_TRANSFER_GAS;
      requireThat(
        value <= sendable,
        422,
        "ADMIN_RESERVE_REQUIRED",
        `관리자 지갑에 ${formatEther(reserve)} RON은 남겨야 합니다. 지금 보낼 수 있는 최대량은 ${sendable > 0n ? formatEther(sendable) : "0"} RON입니다.`,
      );
      const response = idem(p, req, () => {
        const fundingId = id("funding-manual");
        const op = worker.queue(
          "fundRelayer",
          fundingId,
          null,
          a.deployment.id,
          "admin",
          [value.toString()],
        );
        store.audit(p.id, "relayer.fund", {
          trigger: "manual",
          amountWei: value.toString(),
          operationId: op,
        });
        return result(fundingId, op, { fundingId });
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "POST",
    "/issuances",
    "관리자 CGC 추가 발행 (보유분 충전 또는 운영자 지갑)",
    object(
      {
        assetId: string,
        amount: amountSchema,
        target: { type: "string", enum: ["reserve", "operator"] },
        operatorId: string,
        issuanceRef: string,
      },
      ["assetId", "amount", "target", "issuanceRef"],
    ),
    async (req, reply, p) => {
      only(p, "admin");
      ensureAsset(req.body.assetId);
      const value = amount(req.body.amount);
      const a = active();
      requireThat(a.wallets.admin, 503, "SIGNER_UNAVAILABLE");
      let recipient: string = a.deployment.admin;
      if (req.body.target === "operator") {
        const operator = store.get(
          "SELECT * FROM accounts WHERE id=? AND role='operator'",
          req.body.operatorId ?? "",
        );
        requireThat(operator?.wallet, 422, "OPERATOR_WALLET_REQUIRED");
        recipient = operator.wallet;
      }
      const contentHash = sha(canonical(req.body));
      const existing = () =>
        store.get(
          "SELECT * FROM issuances WHERE business_ref=?",
          req.body.issuanceRef,
        );
      const old = existing();
      if (old)
        requireThat(
          old.content_hash === contentHash,
          409,
          "BUSINESS_REFERENCE_CONFLICT",
        );
      else {
        const block = await a.finalBlock();
        const [supply, cap] = await Promise.all([
          a.readToken("totalSupply", block.number),
          a.readToken("cap"),
        ]);
        // Mints still in flight are not in totalSupply yet but already count against the cap.
        const pending = store
          .all(
            "SELECT amount FROM issuances WHERE deployment_id=? AND status='MINTING'",
            a.deployment.id,
          )
          .reduce((sum, row) => sum + BigInt(row.amount), 0n);
        requireThat(
          supply + pending + value <= cap,
          422,
          "SUPPLY_CAP_EXCEEDED",
          `발행 한도를 넘습니다. 추가로 발행할 수 있는 양은 ${display(cap - supply - pending)} CGC입니다.`,
        );
      }
      const response = idem(p, req, () => {
        const prior = existing();
        if (prior) {
          requireThat(
            prior.content_hash === contentHash,
            409,
            "BUSINESS_REFERENCE_CONFLICT",
          );
          return operationResult("mint", prior.id, { issuanceId: prior.id });
        }
        const issuanceId = id("issuance");
        store.run(
          "INSERT INTO issuances VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          issuanceId,
          req.body.issuanceRef,
          contentHash,
          a.deployment.id,
          req.body.target,
          recipient,
          value.toString(),
          "MINTING",
          p.id,
          null,
          Date.now(),
        );
        const op = worker.queue(
          "mint",
          issuanceId,
          null,
          a.deployment.id,
          "admin",
          [recipient, value.toString()],
        );
        store.audit(p.id, "issuance.create", { issuanceId, ...req.body });
        return result(issuanceId, op, { issuanceId });
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "POST",
    "/games/:gameId/rewards",
    "게임 서버 보상 지급 요청",
    walletRequest(
      "recipient",
      {
        assetId: string,
        amount: amountSchema,
        rewardRef: string,
        metadata: { type: "object", additionalProperties: true },
      },
      ["assetId", "amount", "rewardRef"],
    ),
    async (req, reply, p) => {
      const g = game(p, req.params.gameId, "rewards", true);
      requireThat(g.active, 409, "GAME_INACTIVE");
      ensureAsset(req.body.assetId);
      const a = active();
      const value = amount(req.body.amount);
      const recipient = gameWallet(
        req.body,
        "recipient",
        g.id,
        a.deployment.chainId,
      );
      await budgetView(a.deployment.id, g.id);
      const response = idem(p, req, () => {
        const old = prior("rewards", g.id, req.body.rewardRef, req.body);
        if (old) return operationResult("reward", old.id, { rewardId: old.id });
        reserveCheck(a.deployment.id, g.id, value);
        const rewardId = id("reward");
        store.run(
          "INSERT INTO rewards VALUES(?,?,?,?,?)",
          rewardId,
          g.id,
          req.body.rewardRef,
          sha(canonical(req.body)),
          json({ ...req.body, recipient, deploymentId: a.deployment.id }),
        );
        const op = worker.queue(
          "reward",
          rewardId,
          g.id,
          a.deployment.id,
          "relayer",
          [chainIdOf(rewardId), chainIdOf(g.id), recipient, value.toString()],
          value.toString(),
        );
        return result(rewardId, op, { rewardId });
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "GET",
    "/games/:gameId/rewards",
    "게임별 보상 지급 결과와 업무 참조 조회",
    null,
    (req, _reply, p) => {
      game(p, req.params.gameId, "rewards");
      const rows = req.query.rewardRef
        ? store.all(
            "SELECT * FROM rewards WHERE game_id=? AND business_ref=?",
            req.params.gameId,
            req.query.rewardRef,
          )
        : store.all(
            "SELECT * FROM rewards WHERE game_id=? ORDER BY rowid DESC LIMIT 100",
            req.params.gameId,
          );
      return {
        rewards: rows.map((row) => {
          const payload = JSON.parse(row.payload);
          const operation = store.get(
            "SELECT id,status FROM operations WHERE resource_id=? AND kind=?",
            row.id,
            "reward",
          );
          return {
            rewardId: row.id,
            ...payload,
            operationId: operation.id,
            status: operation.status,
          };
        }),
      };
    },
  );
  route(
    "POST",
    "/games/:gameId/payments",
    "게임 서버의 가격 확정 주문 생성",
    walletRequest(
      "payer",
      {
        orderId: string,
        assetId: string,
        amount: amountSchema,
        item: object({
          sku: string,
          name: string,
          quantity: { type: "integer", minimum: 1, maximum: 10000 },
        }),
      },
      ["orderId", "assetId", "amount", "item"],
    ),
    async (req, _reply, p) => {
      const g = game(p, req.params.gameId, "payments", true);
      requireThat(g.active, 409, "GAME_INACTIVE");
      ensureAsset(req.body.assetId);
      const a = active();
      const value = amount(req.body.amount);
      const payer = gameWallet(req.body, "payer", g.id, a.deployment.chainId);
      await a.finalBlock();
      const chainTime = await a.chainTime();
      return idem(p, req, () => {
        const old = prior("payments", g.id, req.body.orderId, req.body);
        if (old) return paymentView(old);
        const paymentId = id("payment"),
          expiresAt =
            chainTime + (a.deployment.authorizationWindowSeconds ?? 900);
        const authorization = a.prepareAuthorization("Payment", {
          paymentId: chainIdOf(paymentId),
          gameId: chainIdOf(g.id),
          payer,
          token: a.deployment.token,
          amount: value.toString(),
          orderHash: orderHash(req.body.orderId, req.body.item),
          nonce: nonce(),
          validUntil: expiresAt.toString(),
        });
        store.run(
          "INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          paymentId,
          g.id,
          req.body.orderId,
          sha(canonical(req.body)),
          req.body.playerId ?? `wallet:${payer.toLowerCase()}`,
          a.deployment.id,
          "CREATED",
          json({ ...req.body, payer, authorization }),
          expiresAt,
          null,
          Date.now(),
        );
        return paymentView(
          store.get("SELECT * FROM payments WHERE id=?", paymentId),
        );
      });
    },
  );
  function paymentView(pay: any) {
    return {
      paymentId: pay.id,
      gameId: pay.game_id,
      deploymentId: pay.deployment_id,
      status: pay.status,
      expiresAt: pay.expires_at,
      claimBy: pay.claim_by,
      ...JSON.parse(pay.payload),
    };
  }
  route(
    "GET",
    "/payments/:paymentId",
    "결제 조회와 최신 사용 승인 준비",
    null,
    async (req, _reply, p) => {
      const pay = paymentAccess(p, req.params.paymentId);
      const view = paymentView(pay);
      if (pay.status === "CREATED")
        view.permit = await worker
          .adapter(pay.deployment_id)
          .preparePermit(view.payer, amount(view.amount), pay.expires_at);
      return view;
    },
  );
  route(
    "GET",
    "/games/:gameId/payments",
    "게임별 미완료 주문과 커서 조회",
    null,
    (req, _reply, p) => {
      game(p, req.params.gameId, "payments");
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const cursor = Number(req.query.cursor) || 0;
      const statuses = req.query.status
        ? String(req.query.status).split(",")
        : req.query.orderId
          ? [
              "CREATED",
              "PROCESSING",
              "PAID",
              "DELIVERY_CLAIMED",
              "COMPLETED",
              "REFUNDED",
              "EXPIRED",
            ]
          : ["CREATED", "PROCESSING", "PAID", "DELIVERY_CLAIMED"];
      requireThat(
        statuses.every((s) =>
          [
            "CREATED",
            "PROCESSING",
            "PAID",
            "DELIVERY_CLAIMED",
            "COMPLETED",
            "REFUNDED",
            "EXPIRED",
          ].includes(s),
        ),
        422,
        "INVALID_STATUS",
      );
      const rows = store.all(
        `SELECT rowid AS cursor,* FROM payments WHERE game_id=? AND rowid>? ${req.query.orderId ? "AND business_ref=?" : ""} AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY rowid LIMIT ?`,
        req.params.gameId,
        cursor,
        ...(req.query.orderId ? [String(req.query.orderId)] : []),
        ...statuses,
        limit,
      );
      return {
        payments: rows.map(paymentView),
        nextCursor: rows.at(-1)?.cursor ?? cursor,
      };
    },
  );
  route(
    "POST",
    "/payments/:paymentId/authorizations",
    "이용자 결제 서명 제출",
    authorizationSchema,
    async (req, reply, p) => {
      const pay = paymentAccess(p, req.params.paymentId);
      if (p.role === "game") game(p, pay.game_id, "payments", true);
      else {
        only(p, "player");
        requireThat(ownsPayment(p, pay), 403, "NOT_PAYER");
      }
      // The portal switch replaces the contract flag, so a game switched off
      // accepts no new payment authorization. Resubmitting an accepted one is fine.
      if (
        !store.get(
          "SELECT 1 FROM operations WHERE kind='pay' AND resource_id=?",
          pay.id,
        )
      )
        requireThat(
          store.get("SELECT active FROM games WHERE id=?", pay.game_id)?.active,
          409,
          "GAME_INACTIVE",
          "운영이 중지된 게임의 결제는 승인할 수 없습니다.",
        );
      const a = worker.adapter(pay.deployment_id);
      const data = JSON.parse(pay.payload);
      await a.finalBlock();
      const chainTime = await a.chainTime();
      requireThat(
        await a.verifyAuthorization(
          data.authorization,
          req.body.signature,
          data.payer,
        ),
        422,
        "INVALID_SIGNATURE",
      );
      if (req.body.permitSignature)
        requireThat(
          req.body.permitDeadline === pay.expires_at,
          422,
          "INVALID_PERMIT_DEADLINE",
        );
      const response = idem(p, req, () => {
        const existing = store.get(
          "SELECT * FROM operations WHERE kind=? AND resource_id=?",
          "pay",
          pay.id,
        );
        if (existing && existing.status !== "FAILED")
          return result(pay.id, existing.id, { paymentId: pay.id });
        requireThat(
          pay.status === "CREATED" && chainTime <= pay.expires_at,
          409,
          "PAYMENT_NOT_PAYABLE",
        );
        if (existing) {
          store.run(
            "UPDATE operations SET status='QUEUED',error=NULL,payload=? WHERE id=?",
            json([
              data.authorization.message,
              req.body.signature,
              a.permit(req.body.permitSignature, req.body.permitDeadline),
            ]),
            existing.id,
          );
          store.run(
            "UPDATE payments SET status='PROCESSING' WHERE id=?",
            pay.id,
          );
          return result(pay.id, existing.id, { paymentId: pay.id });
        }
        const op = worker.queue(
          "pay",
          pay.id,
          pay.game_id,
          pay.deployment_id,
          "relayer",
          [
            data.authorization.message,
            req.body.signature,
            a.permit(req.body.permitSignature, req.body.permitDeadline),
          ],
        );
        store.run("UPDATE payments SET status='PROCESSING' WHERE id=?", pay.id);
        return result(pay.id, op, { paymentId: pay.id });
      });
      return reply.code(202).send(response);
    },
  );
  for (const [path, kind, expected] of [
    ["delivery-claims", "claimDelivery", "PAID"],
    ["fulfillments", "fulfill", "DELIVERY_CLAIMED"],
  ] as const) {
    route(
      "POST",
      `/payments/:paymentId/${path}`,
      path === "delivery-claims"
        ? "게임 아이템 지급 시작"
        : "게임 영속 지급 결과 통지",
      path === "fulfillments" ? object({ deliveryRef: string }) : object({}),
      async (req, reply, p) => {
        const pay = paymentAccess(p, req.params.paymentId);
        game(p, pay.game_id, "payments", true);
        await worker.adapter(pay.deployment_id).finalBlock();
        const response = idem(p, req, () => {
          const existing = store.get(
            "SELECT * FROM operations WHERE kind=? AND resource_id=?",
            kind,
            pay.id,
          );
          if (existing)
            return result(pay.id, existing.id, { paymentId: pay.id });
          requireThat(
            store.get("SELECT status FROM payments WHERE id=?", pay.id)
              .status === expected,
            409,
            "INVALID_PAYMENT_STATE",
          );
          const op = worker.queue(
            kind,
            pay.id,
            pay.game_id,
            pay.deployment_id,
            "relayer",
            [chainIdOf(pay.id)],
          );
          return result(pay.id, op, { paymentId: pay.id });
        });
        return reply.code(202).send(response);
      },
    );
  }
  route(
    "POST",
    "/payments/:paymentId/refunds",
    "지급 시작 전 원래 지불자에게 환불",
    object({}),
    async (req, reply, p) => {
      const pay = paymentAccess(p, req.params.paymentId);
      await worker.adapter(pay.deployment_id).finalBlock();
      const response = idem(p, req, () => {
        const existing = store.get(
          "SELECT * FROM operations WHERE kind=? AND resource_id=?",
          "refund",
          pay.id,
        );
        if (existing) return result(pay.id, existing.id, { paymentId: pay.id });
        requireThat(
          store.get("SELECT status FROM payments WHERE id=?", pay.id).status ===
            "PAID",
          409,
          "REFUND_NOT_ALLOWED",
        );
        const op = worker.queue(
          "refund",
          pay.id,
          pay.game_id,
          pay.deployment_id,
          "relayer",
          [chainIdOf(pay.id)],
        );
        return result(pay.id, op, { paymentId: pay.id });
      });
      return reply.code(202).send(response);
    },
  );
  for (const kind of ["deposits", "withdrawals"] as const) {
    route(
      "POST",
      `/games/:gameId/${kind}`,
      `${kind === "deposits" ? "예치" : "인출"} 서명 준비`,
      object({ assetId: string, amount: amountSchema, recipient: address }, [
        "assetId",
        "amount",
      ]),
      async (req, _reply, p) => {
        const g = game(p, req.params.gameId);
        requireThat(
          p.role === "operator" && p.id === g.operator_id && p.wallet,
          403,
          "OPERATOR_REQUIRED",
        );
        ensureAsset(req.body.assetId);
        const a = active();
        await a.finalBlock();
        const chainTime = await a.chainTime();
        const value = amount(req.body.amount);
        return idem(p, req, () => {
          const actionId = id(kind === "deposits" ? "deposit" : "withdrawal"),
            validUntil =
              chainTime + (a.deployment.authorizationWindowSeconds ?? 900);
          const signingRequest = a.prepareAuthorization("BudgetAction", {
            actionId: chainIdOf(actionId),
            gameId: chainIdOf(g.id),
            owner: p.wallet,
            recipient:
              kind === "deposits"
                ? a.deployment.settlement
                : (req.body.recipient ?? p.wallet),
            amount: value.toString(),
            nonce: nonce(),
            validUntil: validUntil.toString(),
            withdrawal: kind === "withdrawals",
          });
          const payload = { signingRequest, amount: req.body.amount };
          store.run(
            "INSERT INTO budget_actions VALUES(?,?,?,?,?,?,?,?)",
            actionId,
            g.id,
            p.id,
            a.deployment.id,
            kind,
            "CREATED",
            json(payload),
            validUntil,
          );
          return { actionId, deploymentId: a.deployment.id, ...payload };
        });
      },
    );
    const param = kind === "deposits" ? "depositId" : "withdrawalId";
    route(
      "POST",
      `/games/:gameId/${kind}/:${param}/authorizations`,
      "운영자 예산 변경 승인 제출",
      authorizationSchema,
      async (req, reply, p) => {
        const g = game(p, req.params.gameId);
        requireThat(p.role === "operator", 403, "OPERATOR_REQUIRED");
        const action = store.get(
          "SELECT * FROM budget_actions WHERE id=? AND game_id=? AND owner_id=? AND kind=?",
          req.params[param],
          g.id,
          p.id,
          kind,
        );
        requireThat(action, 404, "ACTION_NOT_FOUND");
        const data = JSON.parse(action.payload);
        const a = worker.adapter(action.deployment_id);
        await a.finalBlock();
        const chainTime = await a.chainTime();
        requireThat(
          await a.verifyAuthorization(
            data.signingRequest,
            req.body.signature,
            p.wallet as Address,
          ),
          422,
          "INVALID_SIGNATURE",
        );
        if (kind === "withdrawals")
          await budgetView(action.deployment_id, g.id);
        if (req.body.permitSignature)
          requireThat(
            req.body.permitDeadline === action.expires_at,
            422,
            "INVALID_PERMIT_DEADLINE",
          );
        const response = idem(p, req, () => {
          const old = store.get(
            "SELECT * FROM operations WHERE kind=? AND resource_id=?",
            "budgetAction",
            action.id,
          );
          if (old) return result(action.id, old.id, { actionId: action.id });
          requireThat(chainTime <= action.expires_at, 409, "ACTION_EXPIRED");
          const value = amount(data.amount);
          if (kind === "withdrawals")
            reserveCheck(action.deployment_id, g.id, value);
          const op = worker.queue(
            "budgetAction",
            action.id,
            g.id,
            action.deployment_id,
            "relayer",
            [
              data.signingRequest.message,
              req.body.signature,
              a.permit(req.body.permitSignature, req.body.permitDeadline),
            ],
            kind === "withdrawals" ? value.toString() : "0",
          );
          store.run(
            "UPDATE budget_actions SET status='PROCESSING' WHERE id=?",
            action.id,
          );
          store.audit(p.id, kind, { actionId: action.id });
          return result(action.id, op, { actionId: action.id });
        });
        return reply.code(202).send(response);
      },
    );
  }
  route(
    "GET",
    "/games/:gameId/budget-actions",
    "운영자 예치·인출과 사용 승인 조회",
    null,
    async (req, _reply, p) => {
      game(p, req.params.gameId);
      requireThat(p.role !== "game", 403, "OPERATOR_REQUIRED");
      const actions = store.all(
        "SELECT * FROM budget_actions WHERE game_id=? ORDER BY rowid DESC LIMIT 100",
        req.params.gameId,
      );
      return {
        actions: await Promise.all(
          actions.map(async (action) => {
            const payload = JSON.parse(action.payload);
            return {
              ...action,
              payload,
              permit:
                action.kind === "deposits" && action.status === "CREATED"
                  ? await worker
                      .adapter(action.deployment_id)
                      .preparePermit(
                        payload.signingRequest.message.owner,
                        amount(payload.amount),
                        action.expires_at,
                      )
                  : undefined,
            };
          }),
        ),
      };
    },
  );
  route(
    "POST",
    "/payments/:paymentId/resolutions",
    "공동 승인 예외 환불",
    object({
      evidenceHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      validUntil: { type: "integer", minimum: 1 },
      signature,
    }),
    async (req, reply, p) => {
      const pay = paymentAccess(p, req.params.paymentId);
      requireThat(
        p.role === "admin" || p.role === "operator",
        403,
        "RESOLUTION_ROLE_REQUIRED",
      );
      const g = game(p, pay.game_id);
      const a = worker.adapter(pay.deployment_id);
      await a.finalBlock();
      const chainTime = await a.chainTime();
      requireThat(
        pay.status === "DELIVERY_CLAIMED" && req.body.validUntil > chainTime,
        409,
        "RESOLUTION_NOT_ALLOWED",
      );
      const request = a.prepareAuthorization("Resolution", {
        paymentId: chainIdOf(pay.id),
        evidenceHash: req.body.evidenceHash,
        validUntil: req.body.validUntil.toString(),
      });
      requireThat(
        await a.verifyAuthorization(
          request,
          req.body.signature,
          p.role === "admin" ? a.deployment.admin : g.operator_wallet,
        ),
        422,
        "INVALID_SIGNATURE",
      );
      const response = idem(p, req, () => {
        store.run(
          "INSERT INTO resolutions VALUES(?,?,?,?,?)",
          id("resolution"),
          pay.id,
          p.id,
          json({ ...req.body, role: p.role }),
          Date.now(),
        );
        store.audit(p.id, "resolution.approve", {
          paymentId: pay.id,
          evidenceHash: req.body.evidenceHash,
        });
        const approvals = store
          .all(
            "SELECT * FROM resolutions WHERE payment_id=? ORDER BY rowid DESC",
            pay.id,
          )
          .map((r) => JSON.parse(r.payload))
          .filter(
            (r) =>
              r.evidenceHash === req.body.evidenceHash &&
              r.validUntil === req.body.validUntil,
          );
        const admin = approvals.find((r) => r.role === "admin"),
          operator = approvals.find((r) => r.role === "operator");
        if (!admin || !operator)
          return {
            paymentId: pay.id,
            status: "AWAITING_APPROVAL",
            signingRequest: request,
          };
        const op = worker.queue(
          "resolve",
          pay.id,
          pay.game_id,
          pay.deployment_id,
          "relayer",
          [
            chainIdOf(pay.id),
            req.body.evidenceHash,
            req.body.validUntil,
            operator.signature,
            admin.signature,
          ],
        );
        return result(pay.id, op, { paymentId: pay.id });
      });
      return reply.code(202).send(response);
    },
  );
  route(
    "GET",
    "/operations/:operationId",
    "비동기 작업 조회",
    null,
    (req, _reply, p) => {
      const op = store.get(
        "SELECT * FROM operations WHERE id=?",
        req.params.operationId,
      );
      requireThat(op, 404, "OPERATION_NOT_FOUND");
      if (p.role === "player") {
        const pay = store.get(
          "SELECT * FROM payments WHERE id=?",
          op.resource_id,
        );
        const reward = store.get(
          "SELECT * FROM rewards WHERE id=?",
          op.resource_id,
        );
        requireThat(
          ownsPayment(p, pay) || ownsReward(p, reward),
          403,
          "OPERATION_ACCESS_DENIED",
        );
      } else if (op.game_id) game(p, op.game_id);
      else only(p, "admin");
      const { payload, ...safe } = op;
      return {
        ...safe,
        operationId: op.id,
        attempts: store.all(
          "SELECT hash,nonce,status,block_number,block_hash FROM transaction_attempts WHERE operation_id=? ORDER BY rowid",
          op.id,
        ),
      };
    },
  );
  route(
    "POST",
    "/operations/:operationId/replacements",
    "관리자 동일 nonce 수수료 대체",
    object({}),
    async (req, _reply, p) => {
      only(p, "admin");
      requireThat(!worker.busy, 409, "WORKER_BUSY");
      worker.busy = true;
      try {
        const hash = await worker.replace(req.params.operationId);
        store.audit(p.id, "operation.replace", {
          operationId: req.params.operationId,
          hash,
        });
        return { hash };
      } finally {
        worker.busy = false;
      }
    },
  );
  route(
    "GET",
    "/games/:gameId/events",
    "게임 이벤트 커서 조회",
    null,
    (req, _reply, p) => {
      game(p, req.params.gameId, "events");
      const cursor = Number(req.query.cursor) || 0;
      const events = store.all(
        "SELECT * FROM event_outbox WHERE game_id=? AND seq>? ORDER BY seq LIMIT 100",
        req.params.gameId,
        cursor,
      );
      return {
        events: events.map((e) => ({
          eventId: e.id,
          type: e.type,
          resourceId: e.resource_id,
          payload: JSON.parse(e.payload),
          cursor: e.seq,
        })),
        nextCursor: events.at(-1)?.seq ?? cursor,
      };
    },
  );
  route(
    "GET",
    "/admin/overview",
    "관리자 네트워크·작업·장애·회계",
    null,
    async (_req, _reply, p) => {
      only(p, "admin");
      const a = active();
      const block = await a.finalBlock();
      const [
        reserve,
        budgets,
        escrow,
        balance,
        gasBalance,
        supply,
        cap,
        adminGas,
      ] = await Promise.all([
        a.read("reserve", [], block.number),
        a.read("totalBudgets", [], block.number),
        a.read("totalEscrow", [], block.number),
        a.getBalance(a.deployment.settlement, block.number),
        a.publicClient.getBalance({ address: a.deployment.relayer }),
        a.publicClient.readContract({
          address: a.deployment.token,
          abi: (await import("./contracts.js")).artifact("CommonCredit").abi,
          functionName: "totalSupply",
          blockNumber: block.number,
        }),
        a.readToken("cap"),
        a.publicClient.getBalance({ address: a.deployment.admin }),
      ]);
      return {
        deployment: a.deployment,
        accounting: {
          reserve: display(reserve),
          budgets: display(budgets),
          escrow: display(escrow),
          balance: display(balance),
          unclassified: display(balance - reserve - budgets - escrow),
          solvent: balance >= reserve + budgets + escrow,
          totalSupply: display(supply),
          supplyCap: display(cap),
          relayerGasWei: gasBalance.toString(),
          adminGasWei: adminGas.toString(),
          blockNumber: block.number.toString(),
        },
        relayerFunding: {
          auto: worker.funding
            ? {
                minWei: worker.funding.minWei.toString(),
                topupWei: worker.funding.topupWei.toString(),
                adminMinWei: worker.funding.adminMinWei.toString(),
              }
            : null,
          warning: worker.fundingWarning,
          recent: store
            .all(
              "SELECT * FROM operations WHERE kind='fundRelayer' ORDER BY rowid DESC LIMIT 10",
            )
            .map((o) => ({
              operationId: o.id,
              amountWei: JSON.parse(o.payload)[0],
              trigger: o.resource_id.startsWith("funding-auto")
                ? "auto"
                : "manual",
              status: o.status,
              error: o.error,
              createdAt: o.created_at,
            })),
        },
        issuances: store
          .all("SELECT * FROM issuances ORDER BY rowid DESC LIMIT 20")
          .map((i) => ({
            issuanceId: i.id,
            issuanceRef: i.business_ref,
            target: i.target,
            recipient: i.recipient,
            amount: display(BigInt(i.amount)),
            status: i.status,
            error: i.error,
            createdAt: i.created_at,
          })),
        games: await Promise.all(
          store.all("SELECT * FROM games").map(async (g) => ({
            ...g,
            budget: (() => {
              const snapshot = store.get(
                "SELECT amount,block_number FROM budget_snapshots WHERE deployment_id=? AND game_id=?",
                a.deployment.id,
                g.id,
              );
              return snapshot
                ? display(
                    BigInt(snapshot.amount) +
                      worker.incoming(
                        a.deployment.id,
                        g.id,
                        snapshot.block_number,
                      ),
                  )
                : null;
            })(),
            chainActive: (
              (await a.read("games", [chainIdOf(g.id)])) as [string, boolean]
            )[1],
            chainPending: !!store.get(
              "SELECT 1 FROM operations WHERE kind='registerGame' AND game_id=? AND status NOT IN ('FINALIZED','FAILED')",
              g.id,
            ),
          })),
        ),
        registrations: registrations(),
        accounts: store.all(
          "SELECT id,username,role,wallet FROM accounts WHERE role='operator'",
        ),
        operations: store.all(
          "SELECT id,kind,resource_id,game_id,status,error,created_at FROM operations ORDER BY rowid DESC LIMIT 300",
        ),
        payments: store.all(
          "SELECT id,game_id,status,claim_by,created_at FROM payments ORDER BY rowid DESC LIMIT 100",
        ),
        audit: store.all(
          "SELECT * FROM audit_events ORDER BY rowid DESC LIMIT 300",
        ),
        workerError: worker.lastError,
      };
    },
  );
  route(
    "POST",
    "/admin/deployments/active",
    "신규 작업 대상 배포",
    object({ deploymentId: string }),
    async (req, _reply, p) => {
      only(p, "admin");
      const a = worker.adapter(req.body.deploymentId);
      await a.finalBlock();
      store.transaction(() => {
        store.run(
          "UPDATE assets SET active_deployment=? WHERE id=?",
          a.deployment.id,
          ASSET,
        );
        store.audit(p.id, "deployment.activate", req.body);
      });
      return { deploymentId: a.deployment.id };
    },
  );
  app.get("/openapi.json", { schema: { hide: true } }, () => app.swagger());
  app.get("/health", { schema: { hide: true } }, async (_req, reply) => {
    try {
      for (const a of worker.adapters.values()) await a.finalBlock();
      return { status: "ready", workerError: worker.lastError };
    } catch {
      return reply
        .code(503)
        .send({ status: "degraded", workerError: worker.lastError });
    }
  });
  if (options.staticFiles !== false)
    await app.register(fastifyStatic, { root: resolve("public") });
  return app;
}
