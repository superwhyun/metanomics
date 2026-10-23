import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress } from "viem";
import { normalizeWalletAlias } from "../src/wallet-alias.js";
import { Store } from "../src/db.js";
import {
  bindLoginWallet,
  loginWalletDetails,
  setLoginWalletAlias,
} from "../src/wallet-auth.js";
import {
  WalletAliasCache,
  WALLET_ALIAS_CACHE_KEY,
} from "../web/wallet-aliases.js";

const address = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const other = "0x1000000000000000000000000000000000000001";
const memoryStorage = () => {
  let raw: string | null = null;
  return {
    getItem: (_key: string) => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
};

test("whitespace normalization trims actual tabs/newlines/unicode spaces and leaves literal backslashes intact", () => {
  assert.equal(
    normalizeWalletAlias(" \t게임\n\r  지갑\u00a0\u3000"),
    "게임 지갑",
  );
  assert.equal(
    normalizeWalletAlias(String.raw`지갑\s별명`),
    String.raw`지갑\s별명`,
  );
  assert.equal(normalizeWalletAlias(" \t\n\u3000"), "");
});

test("legacy login-wallet databases migrate without losing rows and persist alias updates/deletion across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "metanomic-alias-"));
  const path = join(dir, "network.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, wallet TEXT);
    CREATE TABLE login_wallets(address TEXT PRIMARY KEY COLLATE NOCASE, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL);
    INSERT INTO accounts VALUES('owner','owner','wallet-only','player',NULL);`);
  legacy
    .prepare("INSERT INTO login_wallets VALUES(?,'owner',123)")
    .run(address.toLowerCase());
  legacy.close();
  let store = new Store(path);
  try {
    assert.deepEqual(loginWalletDetails(store, "owner"), [
      { address, alias: null },
    ]);
    setLoginWalletAlias(store, "owner", address, " 게임용 ");
    bindLoginWallet(store, "owner", address);
    store.close();
    store = new Store(path);
    assert.deepEqual(loginWalletDetails(store, "owner"), [
      { address, alias: "게임용" },
    ]);
    assert.equal(
      store.get("SELECT created_at FROM login_wallets").created_at,
      123,
    );
    setLoginWalletAlias(store, "owner", address, "수정");
    store.close();
    store = new Store(path);
    assert.equal(loginWalletDetails(store, "owner")[0].alias, "수정");
    setLoginWalletAlias(store, "owner", address, null);
    store.close();
    store = new Store(path);
    assert.deepEqual(loginWalletDetails(store, "owner"), [
      { address, alias: null },
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("browser hints survive logout/page recreation, normalize address case and forget deleted aliases", () => {
  const storage = memoryStorage();
  let cache = new WalletAliasCache(() => storage);
  cache.remember([
    { address, alias: "지갑" },
    { address: other, alias: "지갑" },
  ]);
  cache = new WalletAliasCache(() => storage);
  assert.equal(cache.alias(address.toLowerCase()), "지갑");
  assert.equal(cache.alias(other), "지갑");
  cache.remember([{ address: address.toLowerCase(), alias: "수정" }]);
  assert.equal(new WalletAliasCache(() => storage).alias(address), "수정");
  cache.remember([{ address, alias: null }]);
  assert.equal(new WalletAliasCache(() => storage).alias(address), null);
  assert.equal(cache.alias(other), "지갑");
  assert.equal(cache.alias("0x2000000000000000000000000000000000000002"), null);
});

test("unavailable storage, quota errors and malformed caches cannot break account selection", () => {
  const throwing = () => {
    throw new Error("storage blocked");
  };
  const cache = new WalletAliasCache(throwing);
  assert.equal(cache.alias(address), null);
  cache.remember([{ address, alias: "메모리 별명" }]);
  assert.equal(cache.alias(address), "메모리 별명");
  const quota = new WalletAliasCache(() => ({
    getItem: () => null,
    setItem: throwing,
  }));
  quota.remember([{ address, alias: "메모리" }]);
  assert.equal(quota.alias(address), "메모리");
  for (const raw of [
    "{",
    "null",
    "[]",
    '{"version":2,"wallets":[]}',
    "x".repeat(64_001),
    JSON.stringify({
      version: 1,
      wallets: [
        null,
        { address: "invalid", alias: "bad" },
        { address, alias: {} },
        { address, alias: "x".repeat(41) },
      ],
    }),
  ]) {
    const invalid = new WalletAliasCache(() => ({
      getItem: () => raw,
      setItem: () => {},
    }));
    assert.equal(invalid.alias(address), null);
    assert.equal(invalid.alias("bad"), null);
  }
  const storage = memoryStorage();
  storage.setItem(
    WALLET_ALIAS_CACHE_KEY,
    JSON.stringify({
      version: 1,
      wallets: [{ address, alias: "<script>alert(1)</script>" }],
    }),
  );
  assert.equal(
    new WalletAliasCache(() => storage).alias(address),
    "<script>alert(1)</script>",
  );
});
