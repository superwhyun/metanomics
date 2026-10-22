import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { build } from "esbuild";
import { loadRuntime, requireExternalDeployment } from "../src/runtime.js";

const children: ChildProcess[] = [];
let closing = false;
async function close(code: number) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    }),
  );
}
process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
function launch(name: string, path: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", path], {
    stdio: "inherit",
    env: { ...process.env, ...extra },
  });
  children.push(child);
  child.once("error", () => {
    console.error(`${name} 프로세스를 실행할 수 없습니다.`);
    void close(1);
  });
  child.once("exit", (code, signal) => {
    if (!closing) {
      console.error(
        `${name} 종료 (코드 ${code ?? signal}). 위 오류를 확인하세요.`,
      );
      void close(1);
    }
  });
}
async function main() {
  const config = loadRuntime();
  const db = new DatabaseSync(config.database, { readOnly: true });
  let adminSetupPending = false;
  try {
    try {
      adminSetupPending = !!db.prepare("SELECT 1 FROM admin_setup").get();
    } catch {
      // Databases created before first-run setup have no such table yet.
    }
    const deployments = db.prepare("SELECT config FROM deployments").all();
    if (!deployments.length) throw new Error("외부 체인 배포 설정이 없습니다.");
    for (const row of deployments)
      requireExternalDeployment(JSON.parse(String(row.config)));
  } finally {
    db.close();
  }
  const port = Number(process.env.PORT ?? 3300);
  const origin = process.env.APP_ORIGIN ?? config.origin;
  if (new URL(origin).port !== String(port))
    throw new Error(
      "APP_ORIGIN의 포트와 PORT가 다릅니다. 실행 설정을 확인하세요.",
    );
  for (const checkPort of [port]) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", () =>
        reject(
          new Error(
            `포트 ${checkPort}가 사용 중입니다. 기존 서버를 종료하세요.`,
          ),
        ),
      );
      server.listen(checkPort, "127.0.0.1", () =>
        server.close(() => resolve()),
      );
    });
  }
  await build({
    entryPoints: ["web/app.ts", "web/wallet-check.ts"],
    bundle: true,
    format: "esm",
    outdir: "public",
  });
  if (closing) return;
  console.log(`외부 Ronin 테스트넷에 연결 중 · DB: ${config.database}`);
  launch("API", "src/main.ts");
  const deadline = Date.now() + 60_000;
  while (!closing) {
    const ready = await fetch(`http://127.0.0.1:${port}/openapi.json`, {
      signal: AbortSignal.timeout(1000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error(
        "API 시작 시간이 초과됐습니다. RPC 연결과 위 오류를 확인하세요.",
      );
    await new Promise((r) => setTimeout(r, 500));
  }
  if (closing) return;
  // Sample games are retired from the operating environment; src/game-main.ts
  // remains only as the reference integration exercised by the tests.
  console.log(
    `Metanomic: ${origin} · API 문서: ${origin}/docs\n로그인: 브라우저 지갑 확장 프로그램 (비밀번호 로그인은 PASSWORD_LOGIN=1일 때만)\n종료: Ctrl+C`,
  );
  if (adminSetupPending)
    console.log(
      `초기 설정 대기: ${origin}에서 var/admin-setup-code의 코드로 관리자 로그인 지갑을 연결하세요.`,
    );
}
try {
  await main();
} catch (error) {
  console.error(
    `서버 시작 실패: ${error instanceof Error ? error.message : "설정을 확인하세요."}`,
  );
  await close(1);
}
