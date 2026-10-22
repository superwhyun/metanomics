import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, canonical, id, json, sha } from "./shared.js";

export class Store {
  db: DatabaseSync;
  constructor(public path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, wallet TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, name TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES accounts(id), operator_wallet TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS game_profiles(game_id TEXT PRIMARY KEY REFERENCES games(id), description TEXT NOT NULL, category TEXT NOT NULL, play_url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS game_registrations(id TEXT PRIMARY KEY, game_id TEXT UNIQUE NOT NULL, operator_id TEXT NOT NULL REFERENCES accounts(id), payload TEXT NOT NULL, status TEXT NOT NULL, review_note TEXT, operation_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS game_credentials(id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), token_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS player_links(game_id TEXT NOT NULL REFERENCES games(id), game_player_id TEXT NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), PRIMARY KEY(game_id,game_player_id), UNIQUE(game_id,player_id));
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, game_id TEXT, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS wallet_links(player_id TEXT NOT NULL REFERENCES players(id), chain_id INTEGER NOT NULL, address TEXT NOT NULL, PRIMARY KEY(player_id,chain_id), UNIQUE(chain_id,address));
      CREATE TABLE IF NOT EXISTS login_wallets(address TEXT PRIMARY KEY COLLATE NOCASE, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_login_wallets ON login_wallets(account_id);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, decimals INTEGER NOT NULL, active_deployment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocations(id TEXT PRIMARY KEY, game_id TEXT NOT NULL, business_ref TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(game_id,business_ref));
      CREATE TABLE IF NOT EXISTS rewards(id TEXT PRIMARY KEY, game_id TEXT NOT NULL, business_ref TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(game_id,business_ref));
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, game_id TEXT NOT NULL, business_ref TEXT NOT NULL, content_hash TEXT NOT NULL, player_id TEXT NOT NULL, deployment_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, claim_by INTEGER, created_at INTEGER NOT NULL, UNIQUE(game_id,business_ref));
      CREATE TABLE IF NOT EXISTS budget_actions(id TEXT PRIMARY KEY, game_id TEXT NOT NULL, owner_id TEXT NOT NULL, deployment_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL, game_id TEXT, deployment_id TEXT NOT NULL, signer TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, reservation TEXT NOT NULL DEFAULT '0', error TEXT, created_at INTEGER NOT NULL, UNIQUE(kind,resource_id));
      CREATE TABLE IF NOT EXISTS transaction_attempts(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), hash TEXT UNIQUE NOT NULL, raw TEXT NOT NULL, nonce INTEGER NOT NULL, status TEXT NOT NULL, block_number TEXT, block_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency_records(scope TEXT NOT NULL, request_key TEXT NOT NULL, content_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,request_key));
      CREATE TABLE IF NOT EXISTS chain_events(id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, block_number TEXT NOT NULL, block_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, game_id TEXT, type TEXT NOT NULL, resource_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_cursors(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_snapshots(deployment_id TEXT NOT NULL, game_id TEXT NOT NULL, block_number TEXT NOT NULL, block_hash TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(deployment_id,game_id));
      CREATE TABLE IF NOT EXISTS issuances(id TEXT PRIMARY KEY, business_ref TEXT UNIQUE NOT NULL, content_hash TEXT NOT NULL, deployment_id TEXT NOT NULL, target TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_setup(id TEXT PRIMARY KEY CHECK(id='admin'), code_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS disabled_accounts(account_id TEXT PRIMARY KEY REFERENCES accounts(id), reason TEXT NOT NULL, disabled_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_applications(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), wallet TEXT NOT NULL, display_name TEXT NOT NULL, contact TEXT NOT NULL, introduction TEXT NOT NULL, status TEXT NOT NULL, review_note TEXT, created_at INTEGER NOT NULL, reviewed_at INTEGER);
      CREATE INDEX IF NOT EXISTS account_operator_applications ON operator_applications(account_id,status);
      CREATE INDEX IF NOT EXISTS operation_queue ON operations(status,created_at);
      CREATE INDEX IF NOT EXISTS game_events ON event_outbox(game_id,seq);
      CREATE INDEX IF NOT EXISTS payment_recovery ON payments(game_id,status,created_at);
      CREATE INDEX IF NOT EXISTS operator_registrations ON game_registrations(operator_id,status);
    `);
    this.seedDemoProfiles();
  }
  seedDemoProfiles() {
    for (const [gameId, description, category] of [
      [
        "game-a",
        "10초 동안 나타나는 신호를 잡고 주간 보상 10코인을 받으세요.",
        "아케이드",
      ],
      [
        "game-b",
        "공통 코인으로 초보자 이용권을 구매하고 첫 구매 보상 1코인을 받으세요.",
        "컬렉션",
      ],
    ])
      this.run(
        "INSERT OR IGNORE INTO game_profiles SELECT id,?,?,'' FROM games WHERE id=?",
        description,
        category,
        gameId,
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
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  audit(actor: string, action: string, payload: unknown) {
    this.run(
      "INSERT INTO audit_events VALUES(?,?,?,?,?)",
      id("audit"),
      actor,
      action,
      json(payload),
      Date.now(),
    );
  }
  event(
    gameId: string | null,
    type: string,
    resourceId: string,
    payload: unknown,
    eventId = id("event"),
  ) {
    this.run(
      "INSERT OR IGNORE INTO event_outbox(id,game_id,type,resource_id,payload) VALUES(?,?,?,?,?)",
      eventId,
      gameId,
      type,
      resourceId,
      json(payload),
    );
  }
  idem(scope: string, key: string, body: unknown, fn: () => any) {
    if (!key || key.length > 200)
      throw new AppError(
        422,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key가 필요합니다.",
      );
    return this.transaction(() => {
      const hash = sha(canonical(body));
      const prior = this.get(
        "SELECT * FROM idempotency_records WHERE scope=? AND request_key=?",
        scope,
        key,
      );
      if (prior) {
        if (prior.content_hash !== hash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "같은 요청 키의 내용이 다릅니다.",
          );
        return JSON.parse(prior.response);
      }
      const result = fn();
      this.run(
        "INSERT INTO idempotency_records VALUES(?,?,?,?)",
        scope,
        key,
        hash,
        json(result),
      );
      return result;
    });
  }
  close() {
    this.db.close();
  }
}
