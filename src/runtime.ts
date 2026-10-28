import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Deployment } from "./shared.js";

// Environment values supplied by the caller take precedence over the file.
export function runtimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const file = env.ENV_FILE ?? "var/saigon.env";
  if (env.ENV_FILE && !existsSync(file))
    throw new Error(`환경 파일이 없습니다: ${file}`);
  const defaults = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const merged = { ...defaults, ...env };
  if (!merged.CONFIG_PATH)
    throw new Error(
      "외부 체인 설정이 필요합니다. var/saigon.env의 CONFIG_PATH를 확인하세요.",
    );
  return merged;
}

export function loadRuntime() {
  Object.assign(process.env, runtimeEnvironment());
  const path = process.env.CONFIG_PATH!;
  if (!existsSync(path)) throw new Error(`서버 설정 파일이 없습니다: ${path}`);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`서버 설정 JSON을 읽을 수 없습니다: ${path}`);
  }
  if (!config.database) throw new Error("설정에 database가 필요합니다.");
  if (!existsSync(config.database))
    throw new Error(`기존 서버 데이터베이스가 없습니다: ${config.database}`);
  return config;
}

export function requireExternalDeployment(deployment: {
  chainId: number;
  finality: string;
}) {
  if (deployment.chainId === 31337 || deployment.finality === "local")
    throw new Error(
      "로컬 체인 설정으로 서버를 실행할 수 없습니다. CONFIG_PATH를 외부 테스트넷 설정으로 변경하세요.",
    );
}

/**
 * FINALITY=finalized|depth (and CONFIRMATIONS for depth) override the stored
 * deployment setting so an existing deployment can switch without a rewrite.
 * Local deployments keep their own setting.
 */
export function applyFinalityOverride(
  deployment: Deployment,
  env: NodeJS.ProcessEnv = process.env,
): Deployment {
  const mode = env.FINALITY;
  if (!mode || deployment.finality === "local") return deployment;
  if (mode === "finalized") {
    const { confirmations: _unused, ...rest } = deployment;
    return { ...rest, finality: "finalized" };
  }
  if (mode === "depth") {
    const confirmations = Number(env.CONFIRMATIONS);
    return { ...deployment, finality: "depth", confirmations };
  }
  throw new Error(`FINALITY must be finalized or depth, got: ${mode}`);
}
