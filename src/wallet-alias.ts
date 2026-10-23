// Display metadata only; never use an alias for identity or authorization.
export const WALLET_ALIAS_MAX_LENGTH = 40;
export function normalizeWalletAlias(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
