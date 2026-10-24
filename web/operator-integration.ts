export type GameCredential = {
  id: string;
  label: string;
  scopes: string[];
  createdAt?: number;
};
type IntegrationGame = {
  game: { id: string; name: string };
  credentials: GameCredential[];
};
type IssuedCredential = {
  credentialId: string;
  label: string;
  token: string;
  scopes: string[];
};
type Options = {
  apiUrl: string;
  assetId: string;
  guideUrl: string;
  issue(gameId: string, label: string): Promise<IssuedCredential>;
  revoke(gameId: string, credentialId: string): Promise<void>;
  feedback(message: string, error?: boolean): void;
};

const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function settings(apiUrl: string, gameId: string, key: string) {
  return [
    ["METANOMIC_API_URL", apiUrl],
    ["METANOMIC_GAME_ID", gameId],
    ["METANOMIC_GAME_KEY", key],
  ];
}
export function connectionEnvironment(
  apiUrl: string,
  gameId: string,
  key: string,
) {
  return settings(apiUrl, gameId, key)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n");
}
export function connectionCommand(apiUrl: string, gameId: string, key: string) {
  return (
    settings(apiUrl, gameId, key)
      .map(([name, value]) => `${name}=${shellQuote(value)}`)
      .join(" \\\n") + " \\\nnpm run dev"
  );
}

// Only freshly issued keys enter this view; secrets never enter browser storage,
// URLs, credential-list data or the application configuration bundle.
export function renderOperatorIntegration(
  container: HTMLElement,
  games: IntegrationGame[],
  options: Options,
) {
  container.replaceChildren();
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      options.feedback(`${label} 복사 완료`);
    } catch {
      options.feedback(
        "복사하지 못했습니다. 표시된 값을 직접 선택해 복사하세요.",
        true,
      );
    }
  };
  const copyButton = (
    value: string,
    label: string,
    buttonText = `${label} 복사`,
  ) => {
    const button = node("button", buttonText, "quiet small");
    button.type = "button";
    button.addEventListener("click", () => void copy(value, label));
    return button;
  };
  const field = (label: string, variable: string, value: string) => {
    const row = node("div", undefined, "connection-field");
    const heading = node("div");
    heading.append(node("strong", label), node("small", variable));
    const code = node("code", value);
    row.append(heading, code, copyButton(value, label));
    return row;
  };
  if (!games.length) {
    const empty = node("article", undefined, "panel empty-state");
    empty.append(
      node("h2", "승인된 게임이 아직 없습니다"),
      node(
        "p",
        "게임 등록과 관리자 승인이 끝나면 API 주소·게임 ID·API 키를 여기서 확인할 수 있습니다.",
        "muted",
      ),
    );
    const register = node("button", "게임 등록 신청하기 →", "primary");
    register.type = "button";
    register.dataset.goto = "register";
    empty.append(register);
    container.append(empty);
    return;
  }
  for (const { game, credentials } of games) {
    const card = node("article", undefined, "panel integration-card");
    card.dataset.integrationGame = game.id;
    card.setAttribute("aria-label", game.name);
    const heading = node("header", undefined, "operator-game-head");
    const title = node("div");
    title.append(node("span", game.id, "eyebrow"), node("h2", game.name));
    const count = node("span", undefined, "pill");
    heading.append(title, count);
    card.append(
      heading,
      node("p", "아래 세 값을 게임 서버의 환경 변수에 설정하세요.", "muted"),
    );
    const fields = node("div", undefined, "connection-fields");
    fields.append(
      field("API 주소", "METANOMIC_API_URL", options.apiUrl),
      field("게임 ID", "METANOMIC_GAME_ID", game.id),
    );
    card.append(fields);
    const url = new URL(options.apiUrl);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      card.append(
        node(
          "p",
          "이 주소는 같은 컴퓨터에서 실행하는 게임 서버용입니다. 다른 컴퓨터에서는 접근 가능한 Metanomic 서버 주소를 사용하세요.",
          "muted connection-note",
        ),
      );
    const keySection = node("section", undefined, "connection-key");
    keySection.append(
      node("h3", "게임 API 키"),
      node("code", "METANOMIC_GAME_KEY", "connection-variable"),
      node(
        "p",
        "키 값은 발급 직후 한 번만 표시됩니다. 게임 서버에 보관하고, 브라우저 코드에는 넣지 마세요.",
        "muted",
      ),
    );
    const issueButton = node("button", "게임 API 키 발급", "primary");
    issueButton.type = "button";
    issueButton.dataset.credential = game.id;
    const issued = node("div", undefined, "connection-issued");
    const list = node("div", undefined, "connection-credentials");
    const records = [...credentials];
    let busy = false;
    const renderRecords = () => {
      count.textContent = records.length
        ? `발급된 키 ${records.length}개`
        : "키 미발급";
      count.className = records.length ? "pill" : "pill pending";
      list.replaceChildren();
      if (!records.length) {
        list.append(node("p", "아직 발급한 API 키가 없습니다.", "muted"));
        return;
      }
      list.append(
        node("h4", "발급된 키"),
        node(
          "p",
          "기존 키 값은 다시 볼 수 없습니다. 분실했다면 새 키로 게임 서버 설정을 바꾼 뒤 기존 키를 폐기하세요.",
          "muted",
        ),
      );
      for (const credential of records) {
        const row = node("div", undefined, "activity-row");
        const description = node("div");
        description.append(
          node("strong", credential.label || "이름 없음"),
          node("small", credential.scopes.join(", ")),
        );
        if (credential.createdAt)
          description.append(
            node(
              "small",
              new Date(credential.createdAt).toLocaleString("ko-KR"),
            ),
          );
        const revoke = node("button", "폐기", "quiet");
        revoke.type = "button";
        let armed = false;
        revoke.addEventListener("click", async () => {
          if (!armed) {
            armed = true;
            revoke.textContent = "정말 폐기";
            revoke.classList.add("danger");
            return;
          }
          revoke.disabled = true;
          try {
            await options.revoke(game.id, credential.id);
          } catch (error) {
            options.feedback(
              error instanceof Error
                ? error.message
                : "키를 폐기하지 못했습니다.",
              true,
            );
            revoke.disabled = false;
          }
        });
        row.append(description, revoke);
        list.append(row);
      }
    };
    const preview = node("details", undefined, "connection-preview");
    preview.append(node("summary", "게임 서버 설정 예시"));
    preview.append(
      node(
        "p",
        `아래 YOUR_GAME_API_KEY를 실제 발급 키로 바꾸세요. METANOMIC_ASSET_ID의 기본값은 ${options.assetId}입니다.`,
        "muted",
      ),
    );
    const example = connectionEnvironment(
      options.apiUrl,
      game.id,
      "YOUR_GAME_API_KEY",
    );
    preview.append(
      node("pre", example, "connection-output"),
      copyButton(example, "환경 변수 예시"),
    );
    const renderIssued = (result: IssuedCredential) => {
      issued.replaceChildren();
      issued.append(
        node("h4", `${result.label} · 발급 완료`),
        node(
          "p",
          "이 화면을 새로고침하면 키 값은 다시 볼 수 없습니다. 아래 설정을 게임 서버에 보관하세요.",
          "muted",
        ),
      );
      const secret = node("input");
      secret.type = "text";
      secret.readOnly = true;
      secret.value = result.token;
      secret.setAttribute("aria-label", "발급된 게임 API 키");
      secret.autocomplete = "off";
      secret.spellcheck = false;
      const actions = node("div", undefined, "actions");
      actions.append(
        copyButton(result.token, "API 키"),
        copyButton(
          connectionEnvironment(options.apiUrl, game.id, result.token),
          "환경 변수",
          "환경 변수 설정 복사",
        ),
        copyButton(
          connectionCommand(options.apiUrl, game.id, result.token),
          "실행 명령",
          "실행 명령 복사",
        ),
      );
      issued.append(
        secret,
        actions,
        node(
          "p",
          ".env를 자동으로 읽는 게임 서버는 환경 변수 설정을 저장하세요. 자동으로 읽지 않으면 실행 명령을 사용하세요. 실행 명령은 macOS/Linux의 npm run dev 기준이며 게임 프로젝트 폴더에서 실행합니다.",
          "muted",
        ),
      );
      const command = node("details");
      command.append(
        node("summary", "실행 명령 보기"),
        node(
          "pre",
          connectionCommand(options.apiUrl, game.id, result.token),
          "connection-output",
        ),
      );
      const hide = node("button", "키 보관 완료 · 화면에서 숨기기", "quiet");
      hide.type = "button";
      hide.addEventListener("click", () => {
        issued.replaceChildren();
        issueButton.disabled = false;
      });
      issued.append(command, hide);
      issueButton.disabled = true;
      preview.open = false;
      records.unshift({
        id: result.credentialId,
        label: result.label,
        scopes: result.scopes,
        createdAt: Date.now(),
      });
      renderRecords();
    };
    issueButton.addEventListener("click", () => {
      if (busy) return;
      issued.replaceChildren();
      const form = node("form", undefined, "credential-form");
      const label = node("label", "키 이름");
      const input = node("input");
      input.name = "label";
      input.required = true;
      input.maxLength = 60;
      input.placeholder = "예: 운영 서버, 스테이징";
      label.append(input);
      const submit = node("button", "발급", "primary");
      submit.type = "submit";
      const cancel = node("button", "취소", "quiet");
      cancel.type = "button";
      cancel.addEventListener("click", () => issued.replaceChildren());
      form.append(label, submit, cancel);
      issued.append(form);
      input.focus();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (busy || !name) return;
        busy = true;
        issueButton.disabled = submit.disabled = cancel.disabled = true;
        try {
          renderIssued(await options.issue(game.id, name));
        } catch (error) {
          options.feedback(
            error instanceof Error
              ? error.message
              : "키를 발급하지 못했습니다.",
            true,
          );
          issueButton.disabled = submit.disabled = cancel.disabled = false;
        } finally {
          busy = false;
        }
      });
    });
    renderRecords();
    keySection.append(issueButton, issued, list);
    card.append(
      keySection,
      preview,
      node(
        "p",
        "API 키 발급만으로 게임 서버가 연결되지는 않습니다. 세 값을 설정하고 게임 서버를 재시작한 뒤, 게임 쪽 연결 상태와 사용 가능 예산을 확인하세요.",
        "connection-next",
      ),
    );
    const links = node("p", undefined, "doc-links");
    for (const [text, href] of [
      ["연동 가이드 ↗", options.guideUrl],
      ["API 레퍼런스 ↗", "/docs"],
    ]) {
      const link = node("a", text);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    card.append(links);
    container.append(card);
  }
}
