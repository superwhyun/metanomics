import { getAddress } from "viem";
import {
  normalizeWalletAlias,
  WALLET_ALIAS_MAX_LENGTH,
} from "../src/wallet-alias.js";

export type NamedWallet = { address: string; alias: string | null };
export const WALLET_ALIAS_CACHE_KEY = "metanomic-wallet-aliases-v1";
const addressKey = (value: string) =>
  getAddress(value.toLowerCase()).toLowerCase();
const validAlias = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= WALLET_ALIAS_MAX_LENGTH &&
  normalizeWalletAlias(value) === value &&
  value.length > 0;

// Browser-local hints learned after authentication, never proof of ownership.
// Both obtaining storage and accessing it may throw (privacy mode/quota/security).
export class WalletAliasCache {
  private aliases = new Map<string, string>();
  constructor(
    private storage: () => Pick<Storage, "getItem" | "setItem"> = () =>
      window.localStorage,
  ) {
    try {
      const raw = storage().getItem(WALLET_ALIAS_CACHE_KEY);
      if (!raw || raw.length > 64_000) return;
      const data = JSON.parse(raw);
      if (
        data?.version !== 1 ||
        !Array.isArray(data.wallets) ||
        data.wallets.length > 200
      )
        return;
      for (const wallet of data.wallets) {
        if (typeof wallet?.address !== "string" || !validAlias(wallet.alias))
          continue;
        try {
          this.aliases.set(addressKey(wallet.address), wallet.alias);
        } catch {
          /* Invalid cache row. */
        }
      }
    } catch {
      /* Cache must never prevent sign-in. */
    }
  }
  alias(address: string): string | null {
    try {
      return this.aliases.get(addressKey(address)) ?? null;
    } catch {
      return null;
    }
  }
  remember(wallets: NamedWallet[]) {
    for (const wallet of wallets) {
      try {
        const key = addressKey(wallet.address);
        this.aliases.delete(key);
        if (validAlias(wallet.alias)) this.aliases.set(key, wallet.alias);
      } catch {
        /* Ignore invalid rows. */
      }
    }
    // Bound shared-browser history; most recently refreshed wallets stay last.
    while (this.aliases.size > 200)
      this.aliases.delete(this.aliases.keys().next().value!);
    try {
      this.storage().setItem(
        WALLET_ALIAS_CACHE_KEY,
        JSON.stringify({
          version: 1,
          wallets: [...this.aliases].map(([address, alias]) => ({
            address,
            alias,
          })),
        }),
      );
    } catch {
      /* The in-memory hints still work for this page. */
    }
  }
}

export function renderAccountChoices(
  choices: HTMLElement,
  accounts: string[],
  cache: WalletAliasCache,
  choose: (address: string) => void,
) {
  choices.replaceChildren();
  for (const address of accounts) {
    const row = document.createElement("div");
    row.className = "account-choice-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "account-choice";
    button.title = address;
    button.textContent = `${cache.alias(address) ?? "이름 미등록"} · ${address.slice(0, 7)}…${address.slice(-5)}`;
    button.addEventListener("click", () => choose(address));
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "전체 주소 확인";
    const full = document.createElement("code");
    full.textContent = address;
    details.append(summary, full);
    row.append(button, details);
    choices.append(row);
  }
}

export function renderLoginWallets(
  container: HTMLElement,
  wallets: NamedWallet[],
  save: (wallet: NamedWallet) => Promise<void>,
  feedback: (message: string, error?: boolean) => void,
) {
  container.replaceChildren();
  if (!wallets.length) {
    container.textContent =
      "아직 등록된 로그인 지갑이 없습니다. 기존 계정에 사용할 지갑을 등록하세요.";
    return;
  }
  for (const wallet of wallets) {
    const form = document.createElement("form");
    form.className = "login-wallet-alias";
    const heading = document.createElement("strong");
    heading.textContent = wallet.alias ?? "이름 미등록";
    const full = document.createElement("code");
    full.textContent = wallet.address;
    const label = document.createElement("label");
    label.textContent = "사이트 별명 (40자 이내)";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = WALLET_ALIAS_MAX_LENGTH;
    input.value = wallet.alias ?? "";
    input.placeholder = "예: 게임용 지갑";
    input.autocomplete = "off";
    label.append(input);
    const actions = document.createElement("div");
    actions.className = "actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "별명 저장";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "별명 삭제";
    remove.disabled = wallet.alias === null;
    let busy = false;
    const persist = async (alias: string | null) => {
      if (busy) return;
      busy = true;
      submit.disabled = remove.disabled = input.disabled = true;
      try {
        await save({ address: wallet.address, alias });
        feedback(
          alias
            ? "별명을 저장했습니다."
            : "별명을 삭제했습니다. 지갑 등록은 유지됩니다.",
        );
      } catch (error) {
        feedback(
          error instanceof Error
            ? error.message
            : "별명을 저장하지 못했습니다.",
          true,
        );
      } finally {
        busy = false;
        submit.disabled = input.disabled = false;
        remove.disabled = wallet.alias === null;
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void persist(normalizeWalletAlias(input.value) || null);
    });
    remove.addEventListener("click", () => void persist(null));
    actions.append(submit, remove);
    form.append(heading, full, label, actions);
    container.append(form);
  }
}
