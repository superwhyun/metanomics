import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/api.js";
import { Store } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { passwordHash } from "../src/auth.js";

async function app(t: any, options: { passwordLogin?: boolean }) {
  const store = new Store(":memory:");
  store.run(
    "INSERT INTO accounts VALUES(?,?,?,?,?)",
    "admin",
    "admin",
    passwordHash("admin-password"),
    "admin",
    null,
  );
  const api = await createApi(store, new Worker(store, new Map()), {
    staticFiles: false,
    ...options,
  });
  t.after(async () => {
    await api.close();
    store.close();
  });
  return (password = "admin-password") =>
    api.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { username: "admin", password },
    });
}

test("password login can be switched off so operating servers accept wallet sign-in only", async (t) => {
  const disabled = await app(t, { passwordLogin: false });
  const refused = await disabled();
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error.code, "PASSWORD_LOGIN_DISABLED");
  // A wrong password gets the same answer, so the endpoint reveals nothing.
  assert.equal(
    (await disabled("wrong")).json().error.code,
    "PASSWORD_LOGIN_DISABLED",
  );

  const enabled = await app(t, {});
  assert.equal((await enabled()).statusCode, 200);
});
