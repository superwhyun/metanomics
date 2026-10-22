import { mkdirSync, writeFileSync } from "node:fs";
import { createApi } from "../src/api.js";
import { Store } from "../src/db.js";
import { Worker } from "../src/worker.js";
const store = new Store(":memory:");
const app = await createApi(store, new Worker(store, new Map()), {
  staticFiles: false,
});
await app.ready();
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/openapi.json",
  JSON.stringify(app.swagger(), null, 2) + "\n",
);
await app.close();
store.close();
process.stdout.write("docs/openapi.json generated from runtime schemas.\n");
