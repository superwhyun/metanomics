import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Store } from "./db.js";
import { AppError, opaque, sha } from "./shared.js";

export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}
export function passwordMatches(password: string, hash: string) {
  if (!/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(hash)) return false;
  const [salt, expected] = hash.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 32),
    Buffer.from(expected, "hex"),
  );
}
export type Principal = {
  id: string;
  role: "admin" | "operator" | "player" | "game";
  wallet?: string;
  gameId?: string;
  scopes?: string[];
};
export function authenticate(store: Store, req: any): Principal {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    throw new AppError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  const hash = sha(header.slice(7));
  const session = store.get(
    "SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND NOT EXISTS (SELECT 1 FROM disabled_accounts d WHERE d.account_id=a.id)",
    hash,
    Date.now(),
  );
  if (session)
    return { id: session.id, role: session.role, wallet: session.wallet };
  const credential = store.get(
    "SELECT * FROM game_credentials WHERE token_hash=? AND revoked=0",
    hash,
  );
  if (credential)
    return {
      id: credential.id,
      role: "game",
      gameId: credential.game_id,
      scopes: JSON.parse(credential.scopes),
    };
  throw new AppError(
    401,
    "UNAUTHENTICATED",
    "세션 또는 게임 자격증명이 유효하지 않습니다.",
  );
}
export function login(store: Store, username: string, password: string) {
  const account = store.get(
    "SELECT * FROM accounts WHERE username=?",
    username,
  );
  // Perform a hash even for an unknown account.
  const hash =
    account?.password_hash ??
    "00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000";
  if (!passwordMatches(password, hash) || !account)
    throw new AppError(
      401,
      "LOGIN_FAILED",
      "아이디 또는 비밀번호를 확인하세요.",
    );
  return createSession(store, account);
}

// A one-time code printed at install lets the installer bind their own wallet
// to the admin account. Reissuing replaces any unused code.
export function issueAdminSetupCode(store: Store) {
  const code = opaque().slice(0, 24);
  store.run(
    "INSERT INTO admin_setup VALUES('admin',?,?) ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at",
    sha(code),
    Date.now(),
  );
  return code;
}
export function adminSetupPending(store: Store) {
  return !!store.get("SELECT 1 FROM admin_setup");
}
export function adminSetupCodeMatches(store: Store, code: string) {
  const row = store.get("SELECT code_hash FROM admin_setup WHERE id='admin'");
  return !!row && row.code_hash === sha(code);
}
// Retired accounts keep their history for accounting but can never hold a session.
export function disableAccount(
  store: Store,
  accountId: string,
  reason: string,
) {
  store.transaction(() => {
    store.run(
      "INSERT OR IGNORE INTO disabled_accounts VALUES(?,?,?)",
      accountId,
      reason,
      Date.now(),
    );
    store.run("DELETE FROM sessions WHERE account_id=?", accountId);
  });
}
export function isDisabled(store: Store, accountId: string) {
  return !!store.get(
    "SELECT 1 FROM disabled_accounts WHERE account_id=?",
    accountId,
  );
}
export function createSession(
  store: Store,
  account: any,
  expiresAt = Date.now() + 8 * 3600_000,
) {
  if (isDisabled(store, account.id))
    throw new AppError(
      403,
      "ACCOUNT_DISABLED",
      "사용이 중지된 계정입니다. 다른 계정으로 로그인하세요.",
    );
  const token = opaque();
  store.run(
    "INSERT INTO sessions VALUES(?,?,?)",
    sha(token),
    account.id,
    expiresAt,
  );
  return {
    token,
    account: {
      id: account.id,
      username: account.username,
      role: account.role,
      wallet: account.wallet,
    },
  };
}
