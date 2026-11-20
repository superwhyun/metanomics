import { createHmac } from "node:crypto";
import { Store } from "./db.js";
import { AppError, json } from "./shared.js";

// Webhooks push the same event_outbox records that GET /games/:gameId/events
// serves. Each endpoint keeps its own cursor and receives events one at a time
// in order; a failing event is retried with backoff and blocks later events for
// that endpoint only, so delivery is at-least-once and never reordered.
export const WEBHOOK_BATCH = 20;
export const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 3600_000;

export function webhookSignature(
  secret: string,
  timestamp: number,
  body: string,
) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function webhookUrl(value: string) {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {}
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new AppError(
      422,
      "INVALID_WEBHOOK_URL",
      "웹훅 주소는 계정 정보와 #이 없는 http 또는 https 주소여야 합니다.",
    );
  return url.href;
}

export const backoff = (failures: number) =>
  Math.min(5_000 * 2 ** Math.max(failures - 1, 0), MAX_BACKOFF_MS);

export type WebhookEvent = {
  eventId: string;
  type: string;
  gameId: string | null;
  resourceId: string;
  payload: unknown;
  cursor: number;
};

export class WebhookDispatcher {
  busy = false;
  constructor(
    private store: Store,
    private send: typeof fetch = fetch,
  ) {}

  async post(endpoint: any, event: WebhookEvent, now = Date.now()) {
    const body = json(event);
    const timestamp = Math.floor(now / 1000);
    try {
      const response = await this.send(endpoint.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "Metanomic-Webhooks/1",
          "metanomic-webhook-id": endpoint.id,
          "metanomic-event-id": event.eventId,
          "metanomic-signature": webhookSignature(
            endpoint.secret,
            timestamp,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // Only the status matters; drain the body so the socket can be reused.
      await response.arrayBuffer().catch(() => {});
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status as number | null,
        error:
          response.status >= 200 && response.status < 300
            ? null
            : `HTTP ${response.status}`,
      };
    } catch (error: any) {
      return {
        ok: false,
        status: null,
        error: String(error?.cause?.code ?? error?.name ?? "NETWORK_ERROR"),
      };
    }
  }

  async deliver(endpoint: any, now: number) {
    const events = this.store.all(
      "SELECT * FROM event_outbox WHERE game_id=? AND seq>? ORDER BY seq LIMIT ?",
      endpoint.game_id,
      endpoint.cursor,
      WEBHOOK_BATCH,
    );
    let failures = endpoint.failures;
    for (const e of events) {
      const result = await this.post(
        endpoint,
        {
          eventId: e.id,
          type: e.type,
          gameId: e.game_id,
          resourceId: e.resource_id,
          payload: JSON.parse(e.payload),
          cursor: e.seq,
        },
        now,
      );
      // The endpoint may have been deleted while the request was in flight.
      if (result.ok) {
        failures = 0;
        this.store.run(
          "UPDATE webhook_endpoints SET cursor=?,failures=0,next_attempt_at=0,last_status=?,last_error=NULL,last_delivered_at=? WHERE id=? AND cursor<?",
          e.seq,
          result.status,
          Date.now(),
          endpoint.id,
          e.seq,
        );
      } else {
        failures++;
        this.store.run(
          "UPDATE webhook_endpoints SET failures=?,next_attempt_at=?,last_status=?,last_error=? WHERE id=?",
          failures,
          Date.now() + backoff(failures),
          result.status,
          result.error,
          endpoint.id,
        );
        return;
      }
    }
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.store.all(
        "SELECT w.* FROM webhook_endpoints w WHERE w.next_attempt_at<=? AND EXISTS (SELECT 1 FROM event_outbox e WHERE e.game_id=w.game_id AND e.seq>w.cursor)",
        now,
      );
      // One slow endpoint must not hold up the others.
      await Promise.all(due.map((endpoint) => this.deliver(endpoint, now)));
    } finally {
      this.busy = false;
    }
  }
}
