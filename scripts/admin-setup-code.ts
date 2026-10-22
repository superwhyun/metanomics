import { writeFileSync } from "node:fs";
import { loadRuntime } from "../src/runtime.js";
import { Store } from "../src/db.js";
import { issueAdminSetupCode } from "../src/auth.js";

// Issues a new one-time code for connecting an admin sign-in wallet, e.g. after
// the previous wallet was lost. Shell access to the server is the authority.
const config = loadRuntime();
const store = new Store(config.database);
try {
  if (!store.get("SELECT 1 FROM accounts WHERE role='admin'"))
    throw new Error("관리자 계정이 없습니다. 배포를 먼저 실행하세요.");
  const code = issueAdminSetupCode(store);
  store.audit("system", "admin.setup-code-issued", {});
  writeFileSync("var/admin-setup-code", `${code}\n`, { mode: 0o600 });
  process.stdout.write(
    `관리자 지갑 초기 설정 코드: ${code}\n포털 첫 화면에서 이 코드로 관리자 로그인 지갑을 연결하세요. 한 번만 사용할 수 있습니다.\n`,
  );
} finally {
  store.close();
}
