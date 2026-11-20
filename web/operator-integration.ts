export type GameCredential = {
  id: string;
  label: string;
  scopes: string[];
  createdAt?: number;
};
export type GameWebhook = {
  webhookId: string;
  url: string;
  label: string;
  pendingEvents: number;
  failures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: number | null;
};
type CreatedWebhook = GameWebhook & { secret: string };
type IntegrationGame = {
  game: { id: string; name: string };
  credentials: GameCredential[];
  webhooks?: GameWebhook[];
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
  createWebhook(
    gameId: string,
    url: string,
    label: string,
  ): Promise<CreatedWebhook>;
  testWebhook(
    gameId: string,
    webhookId: string,
  ): Promise<{
    delivered: boolean;
    status: number | null;
    error: string | null;
  }>;
  deleteWebhook(gameId: string, webhookId: string): Promise<void>;
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
      node("p", "게임이 승인되면 여기서 API 키를 발급합니다.", "muted"),
    );
    const register = node("button", "게임 등록 신청하기 →", "primary");
    register.type = "button";
    register.dataset.goto = "register";
    empty.append(register);
    container.append(empty);
    return;
  }
  // Webhooks are optional: polling stays the recovery path, so a game can add
  // them at any time without changing how it completes payments.
  const renderWebhooks = (gameId: string, initial: GameWebhook[]) => {
    const section = node("section", undefined, "connection-key");
    section.dataset.webhooks = gameId;
    section.append(
      node("h3", "웹훅 (선택)"),
      node(
        "p",
        "결제·보상 상태 변경을 즉시 알립니다. 주기 조회는 유지하세요.",
        "muted",
      ),
    );
    const created = node("div", undefined, "connection-issued");
    const list = node("div", undefined, "connection-credentials");
    const records = [...initial];
    const describe = (hook: GameWebhook) =>
      hook.failures
        ? `전송 실패 ${hook.failures}회 · ${hook.lastError ?? "응답 없음"} · 대기 이벤트 ${hook.pendingEvents}개 (자동 재시도)`
        : hook.lastDeliveredAt
          ? `정상 · 마지막 전송 ${new Date(hook.lastDeliveredAt).toLocaleString("ko-KR")}${hook.pendingEvents ? ` · 대기 ${hook.pendingEvents}개` : ""}`
          : "아직 전송한 이벤트가 없습니다.";
    const renderList = () => {
      list.replaceChildren();
      if (!records.length) {
        list.append(node("p", "등록된 웹훅이 없습니다.", "muted"));
        return;
      }
      for (const hook of records) {
        const row = node("div", undefined, "activity-row");
        row.dataset.webhook = hook.webhookId;
        const description = node("div");
        description.append(
          node("strong", hook.label),
          node("small", hook.url),
          node("small", describe(hook), hook.failures ? "warn" : undefined),
        );
        const actions = node("div", undefined, "actions");
        const test = node("button", "테스트 전송", "quiet small");
        test.type = "button";
        test.addEventListener("click", async () => {
          test.disabled = true;
          try {
            const result = await options.testWebhook(gameId, hook.webhookId);
            options.feedback(
              result.delivered
                ? `테스트 이벤트 전송 성공 (HTTP ${result.status})`
                : `테스트 이벤트 전송 실패: ${result.error ?? "응답 없음"}`,
              !result.delivered,
            );
          } catch (error) {
            options.feedback(
              error instanceof Error ? error.message : "전송하지 못했습니다.",
              true,
            );
          } finally {
            test.disabled = false;
          }
        });
        const remove = node("button", "삭제", "quiet small");
        remove.type = "button";
        let armed = false;
        remove.addEventListener("click", async () => {
          if (!armed) {
            armed = true;
            remove.textContent = "정말 삭제";
            remove.classList.add("danger");
            return;
          }
          remove.disabled = true;
          try {
            await options.deleteWebhook(gameId, hook.webhookId);
            records.splice(records.indexOf(hook), 1);
            renderList();
            options.feedback("웹훅을 삭제했습니다.");
          } catch (error) {
            options.feedback(
              error instanceof Error ? error.message : "삭제하지 못했습니다.",
              true,
            );
            remove.disabled = false;
          }
        });
        actions.append(test, remove);
        row.append(description, actions);
        list.append(row);
      }
    };
    const add = node("button", "웹훅 등록", "small");
    add.type = "button";
    add.addEventListener("click", () => {
      created.replaceChildren();
      const form = node("form", undefined, "credential-form");
      const urlLabel = node("label", "받을 주소");
      const url = node("input");
      url.name = "url";
      url.type = "url";
      url.required = true;
      url.placeholder = "https://game.example.com/metanomic/webhook";
      urlLabel.append(url);
      const nameLabel = node("label", "웹훅 이름");
      const name = node("input");
      name.name = "label";
      name.required = true;
      name.maxLength = 60;
      name.value = "게임 서버";
      nameLabel.append(name);
      const submit = node("button", "등록", "primary");
      submit.type = "submit";
      const cancel = node("button", "취소", "quiet");
      cancel.type = "button";
      cancel.addEventListener("click", () => created.replaceChildren());
      form.append(urlLabel, nameLabel, submit, cancel);
      created.append(form);
      url.focus();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = cancel.disabled = true;
        try {
          const hook = await options.createWebhook(
            gameId,
            url.value.trim(),
            name.value.trim(),
          );
          const { secret, ...record } = hook;
          records.unshift(record);
          renderList();
          created.replaceChildren(
            node("h4", `${hook.label} · 등록 완료`),
            node(
              "p",
              "서명 비밀값은 지금 한 번만 표시됩니다. 게임 서버의 METANOMIC_WEBHOOK_SECRET에 보관하고, 요청마다 Metanomic-Signature 헤더를 검증하세요.",
              "muted",
            ),
          );
          const value = node("input");
          value.type = "text";
          value.readOnly = true;
          value.value = secret;
          value.setAttribute("aria-label", "웹훅 서명 비밀값");
          value.autocomplete = "off";
          value.spellcheck = false;
          const actions = node("div", undefined, "actions");
          const hide = node("button", "보관 완료 · 화면에서 숨기기", "quiet");
          hide.type = "button";
          hide.addEventListener("click", () => created.replaceChildren());
          actions.append(
            copyButton(secret, "서명 비밀값"),
            copyButton(
              `METANOMIC_WEBHOOK_SECRET=${JSON.stringify(secret)}`,
              "환경 변수",
              "환경 변수 복사",
            ),
            hide,
          );
          created.append(value, actions);
        } catch (error) {
          options.feedback(
            error instanceof Error
              ? error.message
              : "웹훅을 등록하지 못했습니다.",
            true,
          );
          submit.disabled = cancel.disabled = false;
        }
      });
    });
    renderList();
    section.append(add, created, list);
    return section;
  };
  for (const { game, credentials, webhooks } of games) {
    const card = node("article", undefined, "panel integration-card");
    card.dataset.integrationGame = game.id;
    card.setAttribute("aria-label", game.name);
    const heading = node("header", undefined, "operator-game-head");
    const title = node("div");
    title.append(node("span", game.id, "eyebrow"), node("h2", game.name));
    const count = node("span", undefined, "pill");
    heading.append(title, count);
    card.append(heading);
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
          "같은 컴퓨터의 게임 서버 전용 주소입니다.",
          "muted connection-note",
        ),
      );
    const keySection = node("section", undefined, "connection-key");
    keySection.append(
      node("h3", "게임 API 키"),
      node("code", "METANOMIC_GAME_KEY", "connection-variable"),
      node(
        "p",
        "키는 발급 직후 한 번만 표시됩니다. 서버에만 보관하세요.",
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
      list.append(node("h4", "발급된 키"));
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
        const revoke = node("button", "폐기", "small danger");
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
        node("p", "새로고침하면 다시 볼 수 없습니다.", "muted"),
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
          ".env에 저장하거나 실행 명령(macOS/Linux, npm run dev)을 사용하세요.",
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
    const hookSection = renderWebhooks(game.id, webhooks ?? []);
    card.append(
      keySection,
      hookSection,
      preview,
      node(
        "p",
        "API 키 발급만으로 게임 서버가 연결되지는 않습니다. 세 값을 설정하고 서버를 재시작하세요.",
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
