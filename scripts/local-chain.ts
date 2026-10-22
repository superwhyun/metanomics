import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { DEVELOPMENT_MNEMONIC } from "../src/provision.js";

function anvilBinary() {
  const require = createRequire(import.meta.url);
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const executable = process.platform === "win32" ? "anvil.exe" : "anvil";
  try {
    return require.resolve(
      `@foundry-rs/anvil-${process.platform}-${arch}/bin/${executable}`,
    );
  } catch {
    const fallback = resolve(
      dirname(require.resolve("@foundry-rs/anvil/package.json")),
      "..",
      "dist",
      executable,
    );
    if (existsSync(fallback)) return fallback;
    throw new Error(
      "Anvil binary is missing. Run npm ci before starting the local chain.",
    );
  }
}

export async function startLocalChain(
  port = 8545,
  statePath?: string,
  blockTimeSeconds?: number,
) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () =>
      reject(
        new Error(
          `Port ${port} is already in use; refusing to attach to another chain`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const child = spawn(
    // The npm wrapper exits on SIGTERM before Anvil finishes flushing state.
    anvilBinary(),
    [
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--chain-id",
      "31337",
      "--hardfork",
      "cancun",
      "--mnemonic",
      DEVELOPMENT_MNEMONIC,
      "--silent",
      ...(blockTimeSeconds ? ["--block-time", String(blockTimeSeconds)] : []),
      ...(statePath
        ? [
            "--state",
            statePath,
            "--state-interval",
            "30",
            "--max-persisted-states",
            "128",
            "--preserve-historical-states",
          ]
        : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stderr?.on("data", (d) => {
    output += d.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({
    transport: http(url, { timeout: 300, retryCount: 0 }),
  });
  // Loading a persisted chain can take longer than creating a fresh test node.
  const startupAttempts = statePath ? 1200 : 100;
  for (let i = 0; i < startupAttempts; i++) {
    if (child.exitCode !== null) throw new Error(`Anvil exited: ${output}`);
    try {
      if ((await client.getChainId()) === 31337) return { child, url, client };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`Anvil did not start: ${output}`);
}
