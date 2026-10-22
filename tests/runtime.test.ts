import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runtimeEnvironment,
  requireExternalDeployment,
} from "../src/runtime.js";

test("external startup loads its environment without replacing explicit settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "metanomic-env-"));
  try {
    const file = join(dir, "external.env");
    writeFileSync(
      file,
      'CONFIG_PATH="external-runtime.json"\nRELAYER_PRIVATE_KEY=test-secret\nPORT=3300\n',
    );
    const env = runtimeEnvironment({ ENV_FILE: file, PORT: "3400" });
    assert.equal(env.CONFIG_PATH, "external-runtime.json");
    assert.equal(env.PORT, "3400");
    assert.equal(env.RELAYER_PRIVATE_KEY, "test-secret");
    assert.equal(
      runtimeEnvironment({ ENV_FILE: file, CONFIG_PATH: "custom.json" })
        .CONFIG_PATH,
      "custom.json",
    );
    assert.throws(
      () => runtimeEnvironment({ ENV_FILE: join(dir, "missing") }),
      /환경 파일/,
    );
    writeFileSync(file, "PORT=3300\n");
    assert.throws(
      () => runtimeEnvironment({ ENV_FILE: file }),
      /외부 체인 설정/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("server startup refuses local deployments and accepts finalized external chains", () => {
  assert.throws(
    () => requireExternalDeployment({ chainId: 31337, finality: "finalized" }),
    /로컬 체인/,
  );
  assert.throws(
    () => requireExternalDeployment({ chainId: 202601, finality: "local" }),
    /로컬 체인/,
  );
  assert.doesNotThrow(() =>
    requireExternalDeployment({ chainId: 202601, finality: "finalized" }),
  );
});
