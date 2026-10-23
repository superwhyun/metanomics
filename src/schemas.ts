// These schemas drive both Fastify serialization and the generated OpenAPI document.
const text = { type: "string" };
const open = (properties: Record<string, any>, required: string[] = []) => ({
  type: "object",
  additionalProperties: true,
  properties,
  required,
});
const array = (items: any) => ({ type: "array", items });
export const signingSchema = open(
  {
    domain: open(
      {
        name: text,
        version: text,
        chainId: { type: "integer" },
        verifyingContract: text,
      },
      ["name", "version", "chainId", "verifyingContract"],
    ),
    types: { type: "object", additionalProperties: true },
    primaryType: text,
    message: { type: "object", additionalProperties: true },
  },
  ["domain", "types", "primaryType", "message"],
);
export const operationSchema = open(
  {
    operationId: text,
    status: {
      type: "string",
      enum: [
        "QUEUED",
        "PREPARED",
        "SUBMITTED",
        "INCLUDED",
        "FINALIZED",
        "RECONCILING",
        "FAILED",
      ],
    },
    rewardId: text,
    paymentId: text,
    allocationId: text,
    actionId: text,
    error: { anyOf: [text, { type: "null" }] },
    attempts: array(
      open({
        hash: text,
        nonce: { type: "integer" },
        status: text,
        block_number: { anyOf: [text, { type: "null" }] },
        block_hash: { anyOf: [text, { type: "null" }] },
      }),
    ),
  },
  ["operationId", "status"],
);
export const paymentSchema = open(
  {
    paymentId: text,
    gameId: text,
    playerId: text,
    orderId: text,
    assetId: text,
    deploymentId: text,
    amount: text,
    payer: text,
    status: {
      type: "string",
      enum: [
        "CREATED",
        "PROCESSING",
        "PAID",
        "DELIVERY_CLAIMED",
        "COMPLETED",
        "REFUNDED",
        "EXPIRED",
      ],
    },
    expiresAt: { type: "integer" },
    claimBy: { anyOf: [{ type: "integer" }, { type: "null" }] },
    item: open({ sku: text, name: text, quantity: { type: "integer" } }, [
      "sku",
      "name",
      "quantity",
    ]),
    authorization: signingSchema,
    permit: signingSchema,
  },
  [
    "paymentId",
    "gameId",
    "playerId",
    "orderId",
    "assetId",
    "deploymentId",
    "amount",
    "payer",
    "status",
    "expiresAt",
    "item",
    "authorization",
  ],
);
export const budgetSchema = open(
  {
    assetId: text,
    deploymentId: text,
    onchain: text,
    incoming: text,
    reserved: text,
    available: text,
    blockNumber: text,
    blockHash: text,
    finalized: { type: "boolean" },
  },
  [
    "assetId",
    "deploymentId",
    "onchain",
    "reserved",
    "available",
    "blockNumber",
    "blockHash",
    "finalized",
  ],
);
export const eventBatchSchema = open(
  {
    events: array(
      open(
        {
          eventId: text,
          type: text,
          resourceId: text,
          payload: { type: "object", additionalProperties: true },
          cursor: { type: "integer" },
        },
        ["eventId", "type", "resourceId", "payload", "cursor"],
      ),
    ),
    nextCursor: { type: "integer" },
  },
  ["events", "nextCursor"],
);
export const actionSchema = open(
  {
    actionId: text,
    deploymentId: text,
    amount: text,
    signingRequest: signingSchema,
  },
  ["actionId", "deploymentId", "amount", "signingRequest"],
);
const gameSchema = open(
  {
    id: text,
    name: text,
    active: { type: "integer" },
    description: text,
    category: text,
    playUrl: text,
  },
  ["id", "name", "active", "description", "category", "playUrl"],
);
const registrationSchema = open(
  {
    registrationId: text,
    gameId: text,
    name: text,
    description: text,
    category: text,
    playUrl: text,
    operatorId: text,
    status: {
      type: "string",
      enum: ["PENDING", "REGISTERING", "APPROVED", "REJECTED", "FAILED"],
    },
    reviewNote: { anyOf: [text, { type: "null" }] },
    operationId: { anyOf: [text, { type: "null" }] },
    error: { anyOf: [text, { type: "null" }] },
    submittedAt: { type: "integer" },
  },
  ["registrationId", "gameId", "name", "status", "operationId"],
);
const nullableText = { anyOf: [text, { type: "null" }] };
const operatorApplicationSchema = open(
  {
    applicationId: text,
    accountId: text,
    wallet: text,
    displayName: text,
    contact: text,
    introduction: text,
    status: { type: "string", enum: ["PENDING", "APPROVED", "REJECTED"] },
    reviewNote: nullableText,
    createdAt: { type: "integer" },
    reviewedAt: { anyOf: [{ type: "integer" }, { type: "null" }] },
  },
  ["applicationId", "accountId", "wallet", "status", "createdAt"],
);
export function responseSchema(method: string, path: string): any {
  if (
    [
      "/sessions/wallet/challenges",
      "/account/login-wallets/challenges",
      "/operator-applications/challenges",
      "/setup/admin-wallet/challenges",
    ].includes(path)
  )
    return open(
      {
        challengeId: text,
        message: text,
        expiresAt: { type: "integer" },
        address: text,
        chainId: { type: "integer" },
      },
      ["challengeId", "message", "expiresAt", "address", "chainId"],
    );
  if (path === "/account/login-wallets/alias")
    return open({ address: text, alias: nullableText }, ["address", "alias"]);
  if (path === "/account/login-wallets")
    return method === "GET"
      ? open(
          {
            addresses: array(text),
            wallets: array(
              open({ address: text, alias: nullableText }, [
                "address",
                "alias",
              ]),
            ),
            signingWallet: { anyOf: [text, { type: "null" }] },
          },
          ["addresses", "wallets", "signingWallet"],
        )
      : open({ address: text, linked: { type: "boolean" } }, [
          "address",
          "linked",
        ]);
  if (path === "/game-registrations")
    return method === "GET"
      ? open({ registrations: array(registrationSchema) }, ["registrations"])
      : registrationSchema;
  if (path.startsWith("/operator-applications"))
    return method === "GET"
      ? open({ applications: array(operatorApplicationSchema) }, [
          "applications",
        ])
      : operatorApplicationSchema;
  if (path.endsWith("/rejections")) return registrationSchema;
  if (path.endsWith("/approvals")) return operationSchema;
  if (method === "GET" && ["/games", "/operator/games"].includes(path))
    return open({ games: array(gameSchema) }, ["games"]);
  if (
    (method === "GET" && path === "/payments/:paymentId") ||
    (method === "POST" && path === "/games/:gameId/payments")
  )
    return paymentSchema;
  if (method === "GET" && path.endsWith("/budget")) return budgetSchema;
  if (method === "GET" && path.endsWith("/events")) return eventBatchSchema;
  if (method === "GET" && path === "/games/:gameId/payments")
    return open(
      { payments: array(paymentSchema), nextCursor: { type: "integer" } },
      ["payments", "nextCursor"],
    );
  if (method === "GET" && path === "/operations/:operationId")
    return operationSchema;
  if (
    method === "POST" &&
    ["/games/:gameId/deposits", "/games/:gameId/withdrawals"].includes(path)
  )
    return actionSchema;
  if (
    method === "POST" &&
    (path === "/allocations" ||
      path.endsWith("/rewards") ||
      path.endsWith("/authorizations") ||
      path.endsWith("/delivery-claims") ||
      path.endsWith("/fulfillments") ||
      path.endsWith("/refunds") ||
      path === "/games")
  )
    return operationSchema;
  if (path === "/games/:gameId" && method === "PATCH")
    return open({ gameId: text, active: { type: "boolean" } }, [
      "gameId",
      "active",
    ]);
  if (path === "/games/:gameId" && method === "DELETE")
    return open({ gameId: text, deleted: { type: "boolean" } }, [
      "gameId",
      "deleted",
    ]);
  if (path.endsWith("/resolutions"))
    return open(
      {
        paymentId: text,
        status: text,
        operationId: text,
        signingRequest: signingSchema,
      },
      ["paymentId", "status"],
    );
  if (
    ["/sessions", "/sessions/wallet", "/setup/admin-wallet"].includes(path) &&
    method === "POST"
  )
    return open(
      {
        token: text,
        account: open({
          id: text,
          username: text,
          role: text,
          wallet: { anyOf: [text, { type: "null" }] },
        }),
      },
      ["token", "account"],
    );
  if (path === "/players/me/balances")
    return open(
      {
        balances: array(
          open(
            {
              assetId: text,
              deploymentId: text,
              address: text,
              amount: text,
              blockNumber: text,
              finalized: { type: "boolean" },
              walletRequired: { type: "boolean" },
            },
            ["assetId", "deploymentId"],
          ),
        ),
      },
      ["balances"],
    );
  return { type: "object", additionalProperties: true };
}
