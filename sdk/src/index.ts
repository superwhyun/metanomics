// Metanomic game server SDK. Server-side only: it holds the game API key.
// No dependencies beyond Node.js 22 (fetch, node:crypto).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type MetanomicOptions = {
  /** API base including /v1, e.g. http://localhost:3300/v1 */
  apiUrl: string;
  gameId: string;
  /** Game API key issued by the operator. Never ship it to a browser. */
  apiKey: string;
  assetId?: string;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /**
   * Retries on network errors, 429 and 5xx. Every mutating call carries an
   * Idempotency-Key, so a retry returns the original result. Default 2.
   */
  maxRetries?: number;
  fetch?: typeof fetch;
};

export type OperationStatus =
  | "QUEUED"
  | "PREPARED"
  | "SUBMITTED"
  | "INCLUDED"
  | "FINALIZED"
  | "RECONCILING"
  | "FAILED";
export type PaymentStatus =
  | "CREATED"
  | "PROCESSING"
  | "PAID"
  | "DELIVERY_CLAIMED"
  | "COMPLETED"
  | "REFUNDED"
  | "EXPIRED";

export type Accepted = { operationId: string; status: OperationStatus };
export type RewardAccepted = Accepted & { rewardId: string };
export type Reward = RewardAccepted & {
  recipient: string;
  amount: string;
  rewardRef: string;
  assetId: string;
  metadata?: Record<string, unknown>;
};
export type Item = { sku: string; name: string; quantity: number };
export type Payment = {
  paymentId: string;
  gameId: string;
  orderId: string;
  payer: string;
  amount: string;
  assetId: string;
  deploymentId: string;
  status: PaymentStatus;
  expiresAt: number;
  claimBy: number | null;
  item: Item;
  authorization: TypedData;
  permit?: TypedData;
};
export type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};
export type Budget = {
  assetId: string;
  deploymentId: string;
  onchain: string;
  incoming: string;
  reserved: string;
  available: string;
  blockNumber: string;
  blockHash: string;
  finalized: boolean;
};
export type GameEvent = {
  eventId: string;
  type: string;
  resourceId: string;
  payload: Record<string, any>;
  cursor: number;
};
export type WebhookEvent = GameEvent & { gameId: string | null };
export type Operation = {
  operationId: string;
  kind: string;
  resource_id: string;
  status: OperationStatus;
  error: string | null;
  attempts: {
    hash: string;
    nonce: number;
    status: string;
    block_number: string | null;
    block_hash: string | null;
  }[];
};
export type CheckoutSession = {
  checkoutSessionId: string;
  paymentId: string;
  url: string;
  expiresAt: number;
};

export class MetanomicError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MetanomicError";
  }
  /** True when the outcome is unknown and retrying with the same key is safe. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const enc = encodeURIComponent;
// Keeps derived idempotency keys under the server's 200-character limit.
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

export class Metanomic {
  readonly gameId: string;
  readonly assetId: string;
  private base: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;
  private send: typeof fetch;

  constructor(options: MetanomicOptions) {
    for (const name of ["apiUrl", "gameId", "apiKey"] as const)
      if (!options[name]) throw new Error(`Metanomic: ${name} is required`);
    this.base = options.apiUrl.replace(/\/+$/, "");
    this.gameId = options.gameId;
    this.apiKey = options.apiKey;
    this.assetId = options.assetId ?? "common-game-credit";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.send = options.fetch ?? fetch;
  }

  /** Reads METANOMIC_API_URL, METANOMIC_GAME_ID, METANOMIC_GAME_KEY, METANOMIC_ASSET_ID. */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    options: Partial<MetanomicOptions> = {},
  ) {
    return new Metanomic({
      apiUrl: env.METANOMIC_API_URL!,
      gameId: env.METANOMIC_GAME_ID!,
      apiKey: env.METANOMIC_GAME_KEY!,
      assetId: env.METANOMIC_ASSET_ID || undefined,
      ...options,
    });
  }

  async request<T = any>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    if (method === "POST" && !idempotencyKey)
      throw new Error("Metanomic: POST requests need an idempotency key");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, body, idempotencyKey);
      } catch (error) {
        if (
          !(error instanceof MetanomicError) ||
          !error.retryable ||
          attempt >= this.maxRetries
        )
          throw error;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }

  private async once<T>(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.send(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: any) {
      throw new MetanomicError(
        0,
        error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
        error?.message ?? "Metanomic request failed",
      );
    }
    const text = await response.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok)
      throw new MetanomicError(
        response.status,
        data.error?.code ?? "HTTP_ERROR",
        data.error?.message ?? `HTTP ${response.status}`,
      );
    return data as T;
  }

  private game(path = "") {
    return `/games/${enc(this.gameId)}${path}`;
  }

  /** Spendable reward budget of this game. */
  budget() {
    return this.request<Budget>("GET", this.game("/budget"));
  }

  readonly rewards = {
    /**
     * Requests a reward. rewardRef is your business key (e.g. "weekly:2026-W46:player-7");
     * the same rewardRef never pays twice. Resolves on acceptance (202), not completion.
     */
    create: (input: {
      recipient: string;
      amount: string;
      rewardRef: string;
      metadata?: Record<string, unknown>;
    }) =>
      this.request<RewardAccepted>(
        "POST",
        this.game("/rewards"),
        { assetId: this.assetId, ...input },
        input.rewardRef,
      ),
    /** Looks up a reward by rewardRef, e.g. after a timed-out create. */
    get: async (rewardRef: string) =>
      (
        await this.request<{ rewards: Reward[] }>(
          "GET",
          this.game(`/rewards?rewardRef=${enc(rewardRef)}`),
        )
      ).rewards[0] ?? null,
    list: async () =>
      (await this.request<{ rewards: Reward[] }>("GET", this.game("/rewards")))
        .rewards,
  };

  readonly payments = {
    /** Creates a priced order. The same orderId returns the same payment. */
    create: (input: {
      payer: string;
      orderId: string;
      amount: string;
      item: Item;
    }) =>
      this.request<Payment>(
        "POST",
        this.game("/payments"),
        { assetId: this.assetId, ...input },
        `order:${input.orderId}`,
      ),
    get: (paymentId: string) =>
      this.request<Payment>("GET", `/payments/${enc(paymentId)}`),
    findByOrderId: async (orderId: string) =>
      (
        await this.request<{ payments: Payment[] }>(
          "GET",
          this.game(`/payments?orderId=${enc(orderId)}`),
        )
      ).payments[0] ?? null,
    list: (
      query: { status?: PaymentStatus[]; cursor?: number; limit?: number } = {},
    ) => {
      const params = new URLSearchParams();
      if (query.status?.length) params.set("status", query.status.join(","));
      if (query.cursor) params.set("cursor", String(query.cursor));
      if (query.limit) params.set("limit", String(query.limit));
      const qs = params.toString();
      return this.request<{ payments: Payment[]; nextCursor: number }>(
        "GET",
        this.game(`/payments${qs ? `?${qs}` : ""}`),
      );
    },
    /** Iterates every payment in the given states across pages. */
    all: (
      status: PaymentStatus[] = [
        "CREATED",
        "PROCESSING",
        "PAID",
        "DELIVERY_CLAIMED",
      ],
    ) => this.paymentPages(status),
    /**
     * Opens the hosted payment page. Send the payer to session.url; they come
     * back to returnUrl with ?paymentId=&orderId=&checkout=submitted|cancelled.
     */
    checkout: (
      paymentId: string,
      input: { returnUrl: string; cancelUrl?: string },
    ) =>
      this.request<CheckoutSession>(
        "POST",
        `/payments/${enc(paymentId)}/checkout-sessions`,
        input,
        `checkout:${paymentId}:${digest(`${input.returnUrl}\n${input.cancelUrl ?? ""}`)}`,
      ),
    /** Relays the payer's own signatures when you build your own payment screen. */
    authorize: (
      paymentId: string,
      input: {
        signature: string;
        permitSignature?: string;
        permitDeadline?: number;
      },
    ) =>
      this.request<Accepted & { paymentId: string }>(
        "POST",
        `/payments/${enc(paymentId)}/authorizations`,
        input,
        `authorize:${paymentId}:${digest(input.signature)}`,
      ),
    /** Step 1 of delivery: allowed once the payment is PAID. */
    claimDelivery: (paymentId: string) =>
      this.request<Accepted & { paymentId: string }>(
        "POST",
        `/payments/${enc(paymentId)}/delivery-claims`,
        {},
        `claim:${paymentId}`,
      ),
    /** Step 2 of delivery: after the item is durably granted in your game DB. */
    fulfill: (paymentId: string, deliveryRef: string) =>
      this.request<Accepted & { paymentId: string }>(
        "POST",
        `/payments/${enc(paymentId)}/fulfillments`,
        { deliveryRef },
        `fulfill:${paymentId}`,
      ),
    /** Refund to the payer; only before delivery starts (PAID). */
    refund: (paymentId: string) =>
      this.request<Accepted & { paymentId: string }>(
        "POST",
        `/payments/${enc(paymentId)}/refunds`,
        {},
        `refund:${paymentId}`,
      ),
  };

  private async *paymentPages(status: PaymentStatus[]) {
    let cursor = 0;
    for (;;) {
      const page = await this.payments.list({ status, cursor });
      yield* page.payments;
      if (!page.payments.length) return;
      cursor = page.nextCursor;
    }
  }

  readonly events = {
    list: (cursor = 0) =>
      this.request<{ events: GameEvent[]; nextCursor: number }>(
        "GET",
        this.game(`/events?cursor=${cursor}`),
      ),
  };

  readonly operations = {
    get: (operationId: string) =>
      this.request<Operation>("GET", `/operations/${enc(operationId)}`),
    /** Polls until FINALIZED or FAILED. Chain finality can take minutes. */
    wait: async (
      operationId: string,
      { timeoutMs = 600_000, intervalMs = 2_000 } = {},
    ) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const op = await this.operations.get(operationId);
        if (op.status === "FINALIZED" || op.status === "FAILED") return op;
        if (Date.now() >= until)
          throw new MetanomicError(
            0,
            "TIMEOUT",
            `Operation ${operationId} still ${op.status}`,
          );
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
}

/**
 * Verifies a webhook request. Pass the raw request body exactly as received
 * (before JSON parsing) and the Metanomic-Signature header. Returns the parsed
 * event, or throws MetanomicError("WEBHOOK_SIGNATURE_INVALID").
 */
export function verifyWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
  { toleranceSeconds = 300, now = Date.now() } = {},
): WebhookEvent {
  const fail = (message: string) =>
    new MetanomicError(401, "WEBHOOK_SIGNATURE_INVALID", message);
  const parts = Object.fromEntries(
    String(signatureHeader ?? "")
      .split(",")
      .map((part) => part.trim().split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? ""))
    throw fail("Missing or malformed signature header");
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds)
    throw fail("Signature timestamp outside tolerance");
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(parts.v1, "hex")))
    throw fail("Signature mismatch");
  return JSON.parse(body);
}
