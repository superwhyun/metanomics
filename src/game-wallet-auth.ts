import { getAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { id, json, opaque, requireThat, sha } from "./shared.js";

type GameStore = {
  get(sql: string, ...args: any[]): any;
  run(sql: string, ...args: any[]): unknown;
  transaction<T>(fn: () => T): T;
};

// A game verifies its own login. No Metanomic user/session or link code is needed.
export class GameWalletAuth {
  constructor(
    private store: GameStore,
    private origin: string,
    private chainId: number,
  ) {}

  challenge(value: string) {
    const address = getAddress(value.toLowerCase());
    requireThat(
      address !== "0x0000000000000000000000000000000000000000",
      422,
      "INVALID_WALLET",
    );
    const now = Date.now();
    const expiresAt = now + 300_000;
    const sessionExpiresAt = now + 8 * 3600_000;
    const challengeId = id("game-login");
    const site = new URL(this.origin);
    const message = createSiweMessage({
      address,
      chainId: this.chainId,
      domain: site.host,
      uri: site.origin,
      scheme: site.protocol.slice(0, -1),
      version: "1",
      nonce: opaque(),
      issuedAt: new Date(now),
      expirationTime: new Date(sessionExpiresAt),
      requestId: challengeId,
      statement:
        "Sign in to this game. This wallet receives CGC rewards. No transaction or token approval.",
    });
    this.store.run(
      "DELETE FROM wallet_challenges WHERE expires_at<=? OR used=1",
      now,
    );
    this.store.run(
      "INSERT INTO wallet_challenges VALUES(?,?,?,?,0)",
      challengeId,
      json({
        address,
        message,
        origin: site.origin,
        chainId: this.chainId,
        sessionExpiresAt,
      }),
      expiresAt,
      now,
    );
    return { challengeId, message, address, chainId: this.chainId, expiresAt };
  }

  async finish(challengeId: string, signature: Hex) {
    const challenge = this.store.get(
      "SELECT * FROM wallet_challenges WHERE id=? AND used=0 AND expires_at>?",
      challengeId,
      Date.now(),
    );
    requireThat(challenge, 422, "INVALID_CHALLENGE");
    const data = JSON.parse(challenge.payload);
    requireThat(
      data.origin === new URL(this.origin).origin &&
        data.chainId === this.chainId,
      422,
      "INVALID_CHALLENGE",
    );
    requireThat(
      await verifyMessage({
        address: data.address,
        message: data.message,
        signature,
      }).catch(() => false),
      422,
      "INVALID_SIGNATURE",
    );
    return this.store.transaction(() => {
      requireThat(
        this.store.get(
          "SELECT id FROM wallet_challenges WHERE id=? AND used=0 AND expires_at>?",
          challengeId,
          Date.now(),
        ),
        409,
        "CHALLENGE_USED",
      );
      this.store.run(
        "UPDATE wallet_challenges SET used=1 WHERE id=?",
        challengeId,
      );
      let account = this.store.get(
        "SELECT * FROM accounts WHERE wallet=? COLLATE NOCASE",
        data.address,
      );
      if (!account) {
        const accountId = id("game-player");
        this.store.run(
          "INSERT INTO accounts(id,username,password_hash,wallet) VALUES(?,?,?,?)",
          accountId,
          data.address.toLowerCase(),
          "wallet-only",
          data.address,
        );
        account = this.store.get(
          "SELECT * FROM accounts WHERE id=?",
          accountId,
        );
      }
      const token = opaque();
      this.store.run(
        "INSERT INTO sessions VALUES(?,?,?)",
        sha(token),
        account.id,
        data.sessionExpiresAt,
      );
      return { token, address: data.address };
    });
  }
}
