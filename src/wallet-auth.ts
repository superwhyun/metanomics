import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { Store } from "./db.js";
import { createSession } from "./auth.js";
import { id, json, opaque, requireThat } from "./shared.js";

// EOA identities are shared across EVM chains. Never assign an address that is
// already a login, approved signer, or receiving wallet of a different account.
export function walletOwner(store: Store, address: string): string | undefined {
  const owners = new Set<string>(
    store
      .all(
        `SELECT account_id AS owner FROM login_wallets WHERE address=? COLLATE NOCASE
     UNION SELECT id AS owner FROM accounts WHERE wallet=? COLLATE NOCASE
     UNION SELECT player_id AS owner FROM wallet_links WHERE address=? COLLATE NOCASE`,
        address,
        address,
        address,
      )
      .map((row) => row.owner),
  );
  requireThat(
    owners.size <= 1,
    409,
    "WALLET_IDENTITY_CONFLICT",
    "이 지갑이 여러 계정에 연결되어 있습니다. 기존 계정으로 로그인해 연결을 확인하세요.",
  );
  return [...owners][0];
}

// Call inside the same transaction as any receiving-wallet change.
export function bindLoginWallet(
  store: Store,
  accountId: string,
  address: string,
) {
  const owner = walletOwner(store, address);
  requireThat(
    !owner || owner === accountId,
    409,
    "WALLET_ALREADY_LINKED",
    "다른 계정에 연결된 지갑입니다. 계정은 자동으로 합치지 않습니다.",
  );
  store.run(
    "INSERT OR IGNORE INTO login_wallets VALUES(?,?,?)",
    getAddress(address),
    accountId,
    Date.now(),
  );
}

export function loginWallets(store: Store, accountId: string): Address[] {
  const addresses = store.all(
    `SELECT address FROM login_wallets WHERE account_id=?
     UNION SELECT wallet AS address FROM accounts WHERE id=? AND wallet IS NOT NULL
     UNION SELECT address FROM wallet_links WHERE player_id=?`,
    accountId,
    accountId,
    accountId,
  );
  return [...new Set(addresses.map((row) => getAddress(row.address)))];
}

type WalletPurpose = "login" | "link" | "operator" | "admin-setup";
const KINDS: Record<WalletPurpose, string> = {
  login: "wallet-login",
  link: "wallet-account-link",
  operator: "operator-wallet",
  "admin-setup": "admin-setup",
};
const STATEMENTS: Record<WalletPurpose, string> = {
  login: "Sign in to Metanomic. No transaction or token approval.",
  link: "Link this wallet to my existing Metanomic account for sign-in. No transaction or token approval.",
  operator:
    "Register this wallet as my Metanomic game operator approval wallet. No transaction or token approval.",
  "admin-setup":
    "Register this wallet as the Metanomic network admin sign-in wallet. No transaction or token approval.",
};

export class WalletAuth {
  constructor(
    private store: Store,
    private origin: string,
  ) {}

  challenge(
    address: Address,
    deployment: { id: string; chainId: number },
    accountId?: string,
    purpose: WalletPurpose = accountId ? "link" : "login",
  ) {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 300_000;
    const sessionExpiresAt = issuedAt + 8 * 3600_000;
    const challengeId = id("sign-in");
    const site = new URL(this.origin);
    const message = createSiweMessage({
      address: getAddress(address),
      chainId: deployment.chainId,
      scheme: site.protocol.slice(0, -1),
      domain: site.host,
      uri: site.origin,
      version: "1",
      nonce: opaque(),
      issuedAt: new Date(issuedAt),
      expirationTime: new Date(sessionExpiresAt),
      requestId: challengeId,
      statement: STATEMENTS[purpose],
    });
    this.store.transaction(() => {
      this.store.run(
        "DELETE FROM challenges WHERE kind IN ('wallet-login','wallet-account-link','operator-wallet','admin-setup') AND (expires_at<=? OR used=1)",
        issuedAt,
      );
      this.store.run(
        "INSERT INTO challenges VALUES(?,?,?,?,?,?,0)",
        challengeId,
        KINDS[purpose],
        accountId ?? getAddress(address),
        null,
        json({
          address: getAddress(address),
          deploymentId: deployment.id,
          chainId: deployment.chainId,
          origin: this.origin,
          sessionExpiresAt,
          message,
        }),
        expiresAt,
      );
    });
    return {
      challengeId,
      message,
      expiresAt,
      address: getAddress(address),
      chainId: deployment.chainId,
    };
  }

  private async verified(
    kind: string,
    challengeId: string,
    signature: Hex,
    accountId?: string,
  ) {
    const challenge = this.store.get(
      "SELECT * FROM challenges WHERE id=? AND kind=? AND used=0 AND expires_at>?",
      challengeId,
      kind,
      Date.now(),
    );
    requireThat(
      challenge && (!accountId || challenge.owner_id === accountId),
      422,
      "INVALID_CHALLENGE",
      "로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 요청하세요.",
    );
    const data = JSON.parse(challenge.payload);
    requireThat(
      data.origin === this.origin,
      422,
      "INVALID_CHALLENGE",
      "로그인 사이트가 다릅니다. 다시 요청하세요.",
    );
    requireThat(
      await verifyMessage({
        address: data.address,
        message: data.message,
        signature,
      }).catch(() => false),
      422,
      "INVALID_SIGNATURE",
      "지갑 서명을 확인할 수 없습니다.",
    );
    return { challenge, data };
  }

  // Call inside a transaction; recheck after asynchronous verification, including expiry and owner.
  private consume(kind: string, challengeId: string, ownerId: string) {
    const consumed = this.store.run(
      "UPDATE challenges SET used=1 WHERE id=? AND kind=? AND owner_id=? AND used=0 AND expires_at>?",
      challengeId,
      kind,
      ownerId,
      Date.now(),
    );
    requireThat(
      consumed.changes === 1,
      409,
      "CHALLENGE_USED",
      "이미 사용되었거나 만료된 로그인 요청입니다.",
    );
  }

  // Proves possession of a wallet for an account-bound purpose; `apply` runs in
  // the same transaction that consumes the challenge.
  async proveWallet<T>(
    purpose: "operator" | "admin-setup",
    challengeId: string,
    signature: Hex,
    accountId: string,
    apply: (address: Address) => T,
  ): Promise<T> {
    const kind = KINDS[purpose];
    const { data } = await this.verified(
      kind,
      challengeId,
      signature,
      accountId,
    );
    return this.store.transaction(() => {
      this.consume(kind, challengeId, accountId);
      return apply(getAddress(data.address));
    });
  }

  async finish(challengeId: string, signature: Hex, accountId?: string) {
    const kind = accountId ? KINDS.link : KINDS.login;
    const { challenge, data } = await this.verified(
      kind,
      challengeId,
      signature,
      accountId,
    );
    return this.store.transaction(() => {
      this.consume(kind, challengeId, challenge.owner_id);
      if (accountId) {
        bindLoginWallet(this.store, accountId, data.address);
        this.store.audit(accountId, "account.wallet-linked", {
          address: data.address,
        });
        return { address: data.address, linked: true };
      }
      let owner = walletOwner(this.store, data.address);
      if (!owner) {
        owner = id("player");
        this.store.run(
          "INSERT INTO accounts VALUES(?,?,?,?,?)",
          owner,
          `wallet-${data.address.toLowerCase().slice(2)}`,
          "wallet-only",
          "player",
          null,
        );
        this.store.run("INSERT INTO players VALUES(?)", owner);
      }
      bindLoginWallet(this.store, owner, data.address);
      const account = this.store.get(
        "SELECT * FROM accounts WHERE id=?",
        owner,
      );
      if (account.role === "player")
        this.store.run(
          "INSERT OR IGNORE INTO wallet_links VALUES(?,?,?)",
          owner,
          data.chainId,
          data.address,
        );
      this.store.audit(owner, "session.wallet-login", {
        address: data.address,
        chainId: data.chainId,
      });
      return createSession(this.store, account, data.sessionExpiresAt);
    });
  }
}
