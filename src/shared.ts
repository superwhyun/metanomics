import { randomBytes, randomUUID, createHash } from "node:crypto";
import { keccak256, toHex, hashStruct, type Address, type Hex } from "viem";

export const ASSET = "common-game-credit";
export const UNIT = 1_000_000n;
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const opaque = () => randomBytes(32).toString("hex");
export const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const chainIdOf = (value: string) => keccak256(toHex(value));
export const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const canonical = (v: any): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
export function amount(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new AppError(
      422,
      "INVALID_AMOUNT",
      "금액은 소수점 6자리 이하의 양수 문자열이어야 합니다.",
    );
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, "0"));
  if (result <= 0n || result >= 2n ** 256n)
    throw new AppError(422, "INVALID_AMOUNT", "금액 범위를 확인하세요.");
  return result;
}
export const display = (value: bigint | string) => {
  const n = BigInt(value);
  return `${n / UNIT}.${(n % UNIT).toString().padStart(6, "0")}`;
};
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const requireThat = (
  condition: unknown,
  status: number,
  code: string,
  message = code,
): void => {
  if (!condition) throw new AppError(status, code, message);
};
export const paymentTypes = {
  Payment: [
    { name: "paymentId", type: "bytes32" },
    { name: "gameId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "orderHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint256" },
  ],
} as const;
export const budgetTypes = {
  BudgetAction: [
    { name: "actionId", type: "bytes32" },
    { name: "gameId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "withdrawal", type: "bool" },
  ],
} as const;
export const resolutionTypes = {
  Resolution: [
    { name: "paymentId", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "validUntil", type: "uint256" },
  ],
} as const;
export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export function orderHash(
  orderId: string,
  item: { sku: string; name: string; quantity: number },
) {
  return hashStruct({
    primaryType: "Order",
    types: {
      Order: [
        { name: "orderId", type: "string" },
        { name: "sku", type: "string" },
        { name: "name", type: "string" },
        { name: "quantity", type: "uint256" },
      ],
    },
    data: { orderId, ...item, quantity: BigInt(item.quantity) },
  });
}
export type Deployment = {
  id: string;
  chainId: number;
  rpcUrl: string;
  token: Address;
  settlement: Address;
  admin: Address;
  relayer: Address;
  fromBlock: string;
  finality: "local" | "finalized";
  authorizationWindowSeconds?: number;
  claimWindowSeconds?: number;
  maxLogBlockRange?: number;
};
export type SigningRequest = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: any;
  primaryType: string;
  message: any;
};
export const emptyPermit = {
  deadline: 0n,
  v: 0,
  r: `0x${"00".repeat(32)}` as Hex,
  s: `0x${"00".repeat(32)}` as Hex,
};
export type Operation = {
  id: string;
  kind: string;
  resource_id: string;
  game_id: string | null;
  deployment_id: string;
  signer: "relayer" | "admin";
  status: string;
  payload: string;
  reservation: string;
  error: string | null;
  created_at: number;
};
