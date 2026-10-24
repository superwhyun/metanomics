# 게임 개발자 연동 가이드

대상: 독립된 게임 서버에 Metanomic의 지갑 로그인 기반 공통 코인 보상·아이템 결제를 추가하는 개발자와 구현 에이전트. 현재 구현의 HTTP API를 기준으로 설명한다.

## 0. 구현 에이전트용 요약

이 문서만 읽고 게임 서버 연동을 구현할 수 있도록 작성했다. 세부 스키마는 실행 중인 서버의 `/docs`(Swagger UI)와 `/openapi.json`이 기준이다.

**운영자에게 받아야 할 값 세 가지**

| 값          | 어디서 확인하나                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| API 주소    | 운영자 **게임 서버 연결** 메뉴의 **API 주소** (현재 접속한 서버 주소 + `/v1`)                             |
| 게임 ID     | 서버가 등록 신청 때 자동으로 만든다(`game-` + 16진수 8자리). 운영자 **게임 서버 연결** 메뉴에서 확인·복사 |
| 게임 API 키 | 운영자 **게임 서버 연결 → 게임 API 키 발급**. 키 이름을 붙여 발급하며 비밀값은 한 번만 표시               |

운영자 계정으로 로그인한 뒤 **게임 서버 연결**에서 승인된 게임별 값을 확인한다. API 주소와 게임 ID는 개별 복사할 수 있다. 새 키 발급 직후 **환경 변수 설정 복사**, **실행 명령 복사**는 실제 키가 채워진 설정을 복사한다. 기존 키는 이름·범위·발급 기록만 남으며 원문은 다시 표시하지 않는다. 분실하면 새 키로 게임 서버 설정을 교체하고 기존 키를 폐기한다.

게임 서버가 아래 이름을 사용한다면 환경 변수 세 가지를 설정한다. 포털은 게임 서버의 `.env` 자동 로드를 보장하지 않는다. `.env`를 읽지 않는 게임은 macOS/Linux에서 게임 프로젝트 폴더를 열고 복사한 실행 명령을 사용한다. 실행 명령은 `npm run dev` 기준이다. `METANOMIC_ASSET_ID`는 기본값이 `common-game-credit`이면 생략할 수 있다.

```sh
METANOMIC_API_URL='http://localhost:3300/v1' \
METANOMIC_GAME_ID='game-xxxxxxxx' \
METANOMIC_GAME_KEY='YOUR_GAME_API_KEY' \
npm run dev
```

`localhost`·`127.0.0.1`은 게임 서버와 Metanomic이 같은 컴퓨터에서 실행될 때만 사용한다. 게임 서버가 다른 컴퓨터에 있으면 그 서버에서 접근할 수 있는 Metanomic 주소를 넣는다. API 키 발급은 외부 게임 서버의 연결 완료를 의미하지 않으므로 설정 후 게임 쪽 연결 상태와 예산 조회를 확인한다.

**구현 순서**: ① 게임 지갑 로그인(§4) → ② 보상 지급(§5) → ③ 주문·결제(§6) → ④ 아이템 지급·완료 통지(§7) → ⑤ 폴링·재시작 복구(§8). 보상만 쓰는 게임은 ①②⑤만 구현한다.

**게임 서버가 호출하는 API** (모두 `Authorization: Bearer <게임 API 키>`, 변경 요청은 `Idempotency-Key` 필수)

| 메서드·경로                                    | 필요한 범위 | 용도                                    |
| ---------------------------------------------- | ----------- | --------------------------------------- |
| `GET /payments/{paymentId}`                    | `payments`  | 결제 내용과 최신 permit 조회            |
| `POST /payments/{paymentId}/authorizations`    | `payments`  | 이용자 지갑의 결제 서명 중계            |
| `GET /games/{gameId}/budget`                   | `budget`    | 사용 가능 예산 조회                     |
| `POST /games/{gameId}/rewards`                 | `rewards`   | 보상 지급 요청 (202)                    |
| `GET /games/{gameId}/rewards?rewardRef=`       | `rewards`   | 보상 조회·응답 유실 복구                |
| `POST /games/{gameId}/payments`                | `payments`  | 주문(결제) 생성                         |
| `GET /games/{gameId}/payments?status=&cursor=` | `payments`  | 결제 목록·재시작 복구                   |
| `POST /payments/{paymentId}/delivery-claims`   | `payments`  | 아이템 지급 시작 (`PAID`일 때)          |
| `POST /payments/{paymentId}/fulfillments`      | `payments`  | 아이템 지급 완료 통지                   |
| `POST /payments/{paymentId}/refunds`           | `payments`  | 지급 시작 전 환불                       |
| `GET /games/{gameId}/events?cursor=`           | `events`    | 상태 변경 이벤트 폴링                   |
| `GET /operations/{operationId}`                | (게임 키)   | 비동기 작업 상태 (`FINALIZED`/`FAILED`) |
| `GET /assets`                                  | 공개        | `assetId`, `deploymentId` 확인          |

**공통 규칙**

- 오류 응답은 항상 `{ "error": { "code": "...", "message": "..." } }`이다. 분기는 `code`로 한다(§9).
- 금액은 소수점 6자리 이하 양수 **문자열**(`"10.000000"`)이다. 부동소수점으로 계산하지 않는다.
- 블록체인 기록이 필요한 요청은 `202`와 `operationId`를 돌려준다. 접수일 뿐 완료가 아니다.
- 같은 `Idempotency-Key` + 같은 본문은 같은 결과를 돌려준다. 재시도에는 키와 본문을 그대로 쓴다.
- API 키는 게임 서버에만 둔다. 브라우저 번들·로그·응답에 넣지 않는다.

## 1. 시작할 때 읽을 파일과 구현 범위

| 자료                         | 용도                                                   |
| ---------------------------- | ------------------------------------------------------ |
| [OpenAPI](openapi.json)      | 요청·응답 스키마, 필수 필드와 헤더                     |
| [API 구현](../src/api.ts)    | 인증 주체·권한·상태 검사와 실제 응답                   |
| [예제 게임](../src/game.ts)  | 서버 API 클라이언트, 주문 저장, 아이템 지급, 복구 작업 |
| [공통 화면](../web/app.ts)   | 지갑 연결, 결제 내용과 토큰 사용 승인 서명             |
| [설계·복구 명세](DESIGN.md)  | 계약 회계, 상태·만료·재시도 규칙                       |
| [검증 기록](VERIFICATION.md) | 로컬·외부 테스트넷 검증의 구분                         |

게임은 자체 로그인·랭킹·상품 가격·아이템 인벤토리를 관리한다. Metanomic은 공통 이용자·지갑 연결, 게임 예산, 코인 보상·결제·정산을 관리한다. 게임 서버는 공통 HTTP API를 사용하며 RPC나 계약 ABI를 직접 호출할 필요가 없다.

현재 제공하는 것은 API, 선택적으로 사용하는 잔액·내역 포털, 통합 테스트용 예제 게임(`src/game.ts`)이다. 운영자가 지갑으로 신청·승인받아 게임과 예산을 등록한다. 일반 이용자는 각 게임에 지갑으로 로그인하면 된다. 포털 가입·게임별 연결 코드 없이 보상을 받고 게임 안에서 결제할 수 있다. npm SDK, 범용 로그인 리다이렉트, 호스팅 결제창 URL, 웹훅은 아직 없다. 각 게임이 자체 지갑 로그인과 결제 서명 화면을 구현한다.

## 2. 선행 설정과 인증 주체

1. [README의 등록 절차](../README.md#운영자의-게임-등록과-이용자-공개)에 따라 운영자가 게임을 신청하고 관리자가 승인한다. 계약 확정 후 활성 게임이 된다.
2. 운영자가 자격증명을 발급한다. 포털은 `links`, `rewards`, `payments`, `events`, `budget` 전체 범위로 발급하고, API(`POST /games/{gameId}/credentials`)로는 필요한 범위만 줄 수 있다. 발급 때 용도를 기억할 **키 이름**(`label`, 예: 운영 서버·스테이징)이 필수다. 키는 여러 개를 동시에 쓸 수 있으므로 새 키로 교체한 뒤 이전 키를 폐기하면 무중단으로 바꿀 수 있다. 폐기한 키는 즉시 막히고 목록에서 삭제된다(감사 기록은 남는다).
3. 관리자가 예산을 배분하거나 운영자가 토큰을 예치한다. 신규 게임 예산은 0이다.
4. 게임 서버에 아래 설정을 추가한다. 이는 **연동할 게임에서 사용할 설정 예시**이며 Metanomic 실행기의 기존 환경 변수 이름을 바꾸는 지시가 아니다.

```dotenv
METANOMIC_API_URL=http://localhost:3300/v1
METANOMIC_GAME_ID=game-1a2b3c4d
METANOMIC_GAME_KEY=<운영자가 발급한 게임 자격증명>
METANOMIC_ASSET_ID=common-game-credit
```

`METANOMIC_API_URL`에는 `/v1`까지 포함한다. Docker·다른 컴퓨터에서 게임 서버를 실행한다면 `localhost` 대신 게임 서버가 접근할 주소를 지정한다. 기본 Metanomic 서버는 루프백에서 수신한다.

| 인증 정보          | 보관·사용 위치                      | 가능한 작업                                                           |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------- |
| 게임 자격증명      | 게임 서버의 비밀 설정               | 자기 게임의 주소 기반 보상·주문, 결제 서명 중계, 지급 시작·완료, 조회 |
| 이용자 세션        | 공통 로그인 화면의 이용자 인증 흐름 | 선택적인 포털 잔액·내역 조회, 본인 결제 이어하기, 로그인 지갑 관리    |
| 운영자·관리자 세션 | 각 관리 화면                        | 등록·심사, 자격증명 발급, 예산 관리                                   |

모두 `Authorization: Bearer <token>` 형식이다. 게임 자격증명을 브라우저 번들에 넣거나 이용자의 결제 승인에 대신 사용하지 않는다. 게임 서버가 이용자 개인키를 받지 않는다.

공통 포털은 지갑 로그인(SIWE)만 사용한다. `POST /sessions`의 아이디·비밀번호 로그인은 서버를 `PASSWORD_LOGIN=1`로 실행한 점검·자동화 환경에서만 동작하며 운영 서버는 `403 PASSWORD_LOGIN_DISABLED`를 반환한다. 게임 자체 로그인과 Metanomic 로그인은 별도다. 새 지갑 이용자 가입은 제공하지만 범용 외부 게임 SSO 리다이렉트는 제공하지 않는다.

### 공통 포털의 지갑 로그인 API

아래 경로는 모두 `/v1` 기준이다. 게임 API 키가 아닌 이용자 지갑 서명으로 세션을 발급한다.

1. `POST /sessions/wallet/challenges`에 `{ "address": "0x...", "deploymentId": "saigon-v2" }`를 보낸다. 응답은 `challengeId`, `message`, `expiresAt`(Unix 밀리초), `address`, `chainId`이다.
2. **응답의 message 원문**을 선택한 지갑의 `personal_sign`으로 서명한다. 텍스트를 임의로 조립하거나 결제용 서명을 재사용하지 않는다.
3. `POST /sessions/wallet`에 `{ "challengeId": "...", "signature": "0x..." }`를 보내 `token`과 `account`를 받는다. 로그인은 체인 거래를 제출하지 않는다.
4. 이후 기존과 같은 `Authorization: Bearer <token>`을 사용한다. `DELETE /sessions/me`로 로그아웃한다.

알 수 없는 지갑은 player 역할만 생성한다. 기존 수령 지갑과 관리자·운영자 승인 주소는 기존 계정으로 해석하며, 같은 주소가 여러 계정에 연결된 기존 데이터는 `WALLET_IDENTITY_CONFLICT`로 거절한다. EVM 지갑 로그인 식별자는 체인 간 공유하고, 수령 지갑은 기존처럼 체인별로 관리한다.

기존 계정에 새 로그인 지갑을 등록할 때는 기존 계정으로 로그인한 후 `POST /account/login-wallets/challenges`에 같은 주소·배포 형식을 보내고, 응답의 등록용 메시지에 서명해 `POST /account/login-wallets`로 제출한다. 로그인용과 등록용 challenge는 서로 교환할 수 없으며, 등록 challenge는 해당 계정의 세션에만 사용한다. `GET /account/login-wallets`로 등록 주소와 계약 승인 지갑을 확인한다. 이미 다른 계정인 지갑은 `WALLET_ALREADY_LINKED`로 거절하고 기록을 자동 병합하지 않는다. 로그인 지갑 등록은 기존 보상 수령 지갑과 계약 승인 주소를 변경하지 않는다.

`GET /account/login-wallets`는 기존 `addresses: string[]`, `signingWallet`을 유지하고 `wallets: { address: string, alias: string | null }[]`를 추가합니다. 주소는 체크섬 형태이고 별명이 없으면 `null`입니다. 인증된 본인 목록에만 별명이 포함됩니다.

`PUT /account/login-wallets/alias`에 `{"address":"0x등록주소","alias":"게임용 지갑"}`을 보내 별명을 저장·수정합니다. 응답은 `{ address, alias }`입니다. `alias: null` 또는 빈 문자열/공백만 보내면 별명만 삭제합니다. 앞뒤 공백 제거 및 연속 공백 축약 후 40 UTF-16 코드 단위 이내여야 하며 원문 입력은 256자 이내입니다. 인증된 일반 계정만 본인 등록 로그인·승인·수령 지갑을 변경할 수 있고 게임 자격증명·비인증 요청·다른 계정 또는 미등록 주소는 거절합니다. 별명에는 인증·서명 권한이 없습니다.

포털은 로그인 후 받은 별명을 주소 소문자 키로 브라우저에 캐시해 로그아웃 뒤 다음 계정 선택에 사용합니다. 다른 브라우저에서 변경한 별명은 다음 인증 목록 조회로 갱신됩니다. 공개 별명 조회 API는 없으며 캐시는 표시용 힌트에 불과합니다. 별명 문자열은 HTML로 해석하지 않고 텍스트로 표시합니다.

Challenge 접수 유효기간은 5분, 세션은 메시지 발급 후 최대 8시간이다. nonce의 검증 후 소비와 계정 생성·연결·세션 발급은 하나의 DB 거래로 보호한다. 만료·취소 시 새 challenge를 발급하고, `429 AUTH_RATE_LIMITED`에서는 잠시 기다린다. 일반 EVM 개인키 지갑만 지원하며 EIP-1271 계약 지갑은 아직 지원하지 않는다.

### 외부 게임의 화면 구성

현재 API는 설정된 공통 포털 origin 이외의 브라우저 변경 요청을 `ORIGIN_DENIED`로 거절하고 범용 CORS를 제공하지 않는다. 공통 포털은 iframe 포함도 허용하지 않는다. 외부 게임 페이지에서 API로 직접 fetch하는 구성은 현재 그대로 사용할 수 없다. 서버 간 호출은 이 브라우저 origin 제약과 구분된다.

외부 게임은 자신의 origin에서 지갑 로그인과 결제 서명을 처리한다. 게임 자체 세션으로 인증한 이용자의 주소·주문을 확인하고 Metanomic API 호출은 서버 API 키로 중계한다. 포털 세션 토큰이나 게임 API 키를 URL·브라우저에 전달하지 않는다. 별도 공통 로그인 리다이렉트나 연결 코드 입력 화면은 필요하지 않다.

## 3. 게임 서버 HTTP 클라이언트

Node.js 22 서버에 복사해 사용할 수 있는 최소 예제다. 타임아웃은 요청 결과 불명이며 자동으로 새 주문이나 새 보상 참조를 만들지 않는다.

```js
const base = process.env.METANOMIC_API_URL.replace(/\/$/, "");
const gameId = process.env.METANOMIC_GAME_ID;
const gameKey = process.env.METANOMIC_GAME_KEY;
const assetId = process.env.METANOMIC_ASSET_ID;

async function network(path, { body, key } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${gameKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result.error?.message ?? "Metanomic request failed",
    );
    error.status = response.status;
    error.code = result.error?.code;
    throw error;
  }
  return result;
}
```

이 함수는 게임 서버용이다. 아래 이용자 인증 API에는 별도로 이용자 세션을 사용한다. 경로 매개변수와 조회 문자열은 `encodeURIComponent`로 인코딩한다.

## 4. 게임에서 지갑으로 로그인

이용자는 게임에 지갑으로 로그인하고, 그 주소로 보상을 받는다. Metanomic 이용자 계정이나 게임별 가입·연결 코드가 필요하지 않다. 게임 내부 계정·점수·인벤토리와 검증한 지갑 주소의 관계는 게임 서버가 관리한다.

1. 게임 서버가 지갑 주소를 받아 게임 자신의 origin·체인·주소·일회용 nonce·만료에 묶인 SIWE 메시지를 발급한다.
2. 이용자가 지갑에서 메시지를 서명한다. 게임 서버가 원래 메시지의 서명·유효기간·nonce를 검증하고 한 번만 소비한 뒤 게임 세션을 발급한다.
3. 이후 보상과 주문의 주소는 **인증된 게임 세션의 지갑 주소**에서 정한다. 브라우저가 보상·주문 요청마다 보내는 임의 주소나 playerId를 신뢰하지 않는다.
4. Metanomic 호출은 게임 서버의 API 키로 한다. 일반 이용자에게 별도의 포털 세션을 요구하지 않는다. 포털은 이용자가 원하는 경우 같은 지갑으로 잔액·내역을 확인하는 화면이다. 나중에 처음 로그인해도 이전 주소 기반 보상·결제 내역을 조회할 수 있다.

[예제 게임](../src/game.ts)은 다음 게임 자체 API를 구현한다. 이 경로는 Metanomic `/v1` API가 아니다.

| 게임 API                                | 요청·동작                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /sessions/wallet/challenges`      | `{ address }` → `{ challengeId, message, address, chainId, expiresAt }`                               |
| `POST /sessions/wallet`                 | `{ challengeId, signature }` → 게임의 `{ token, address }`. `message`를 `personal_sign`으로 서명한다. |
| `GET /me`                               | 게임 세션의 `address`, 점수·인벤토리 조회                                                             |
| `GET /orders/{orderId}`                 | 게임 세션에 속한 주문의 결제 내용·permit 조회                                                         |
| `POST /orders/{orderId}/authorizations` | 본인 게임 주문인지 확인한 뒤 결제·permit 서명을 Metanomic으로 중계                                    |

예제의 `DemoGame.app({ origin, chainId })`에 게임 공개 origin과 활성 배포의 chain ID를 지정한다. `src/game-main.ts`는 `GAME_ORIGIN`(기본 `http://127.0.0.1:GAME_PORT`)과 네트워크의 활성 배포를 사용한다. 로그인 요청은 5분간 한 번, 게임 세션은 8시간 유효하다. 게임 자체 DB에 지갑별 계정과 세션을 저장하며 포털 계정을 만들지 않는다.

지갑 로그인과 CGC 결제는 별도의 서명이다. 로그인 서명으로 토큰을 사용할 수 없다. 로그인에서 검증한 주소와 결제 서명 주소·네트워크가 일치해야 한다. [지갑 제공자 선택 구현](../web/wallet.ts)을 참고할 수 있다.

기존 코드 교환 연동은 호환 경로로 유지한다. 기존 `playerId`를 보내는 게임은 종전 `/player-links/codes` → `/player-links/exchange` 및 수령 지갑 검사를 계속 거친다. 새 연동은 이를 호출하지 않고 보상에 `recipient`, 주문에 `payer`를 보낸다. `recipient`와 `playerId`, 또는 `payer`와 `playerId`를 동시에 보내거나 모두 생략하면 422다. 주소의 대소문자는 정규화하며 영 주소는 거절한다.

## 5. 보상 지급

게임 서버가 보상 조건·대상·금액을 결정하고 요청 전에 업무 참조와 요청 내용을 저장한다.

```js
const rewardRef = `weekly:2026-W43:${gameAccount.id}`;
const reward = await network(`/games/${encodeURIComponent(gameId)}/rewards`, {
  key: rewardRef,
  body: {
    recipient: gameAccount.wallet,
    assetId,
    amount: "10.000000",
    rewardRef,
  },
});
// 202: { rewardId, operationId, status: "QUEUED" }
const operation = await network(
  `/operations/${encodeURIComponent(reward.operationId)}`,
);
// operation.status === "FINALIZED"일 때 보상 지급 완료로 표시한다.
```

금액은 소수점 6자리 이하의 **양수 문자열**이다. 실수 연산으로 금액을 계산하지 않는다. `GET /games/{gameId}/budget`의 `onchain`, `reserved`, `available`로 예산을 확인할 수 있지만 최종 지급 가능 여부는 계약이 검사한다.

동일한 `gameId + rewardRef`는 하나의 보상이다. 재시도 시 키·요청 본문을 유지한다. 랭킹이 바뀌어도 이미 접수한 보상의 금액을 바꾸지 않는다. 응답 유실은 `GET /games/{gameId}/rewards?rewardRef=...`로 복구할 수 있다. 추가 보상은 별도의 실제 업무 참조를 사용한다.

## 6. 주문 생성과 이용자 승인

### 게임 서버에서 주문 생성

게임 서버가 로그인한 계정, 서버 상품 가격, 재고·지급 가능 여부로 주문을 만든다. 아래 `body`를 **네트워크 호출 전에** 게임 DB에 저장하고 재시도에 그대로 사용한다. 네트워크 호출은 게임 DB의 긴 트랜잭션 밖에서 수행한다.

```js
const payment = await network(`/games/${encodeURIComponent(gameId)}/payments`, {
  key: "purchase:order-1001",
  body: {
    payer: gameAccount.wallet,
    orderId: "order-1001",
    assetId,
    amount: "4.000000",
    item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
  },
});
// 200: paymentId, gameId, deploymentId, status: "CREATED",
// orderId, assetId, amount, item, payer, authorization,
// expiresAt, claimBy를 포함하는 결제 객체.
// 반환된 paymentId를 기존 로컬 주문에 연결한다.
```

같은 `gameId + orderId`의 동일 내용은 기존 결제를 반환한다. 클라이언트가 전달한 가격·이용자 ID로 주문을 만들지 않는다. 결제 객체에는 `checkoutUrl`이 없다.

### 게임 안에서 지갑으로 결제 승인

1. 게임 서버가 자체 세션의 주문 소유자를 확인하고 **게임 API 키**로 `GET /payments/{paymentId}`를 호출한다. 해당 게임의 결제인지 Metanomic이 검사하며, `CREATED` 상태에서는 최신 `permit` 서명 요청도 반환한다. 결제 내용을 게임 클라이언트에 전달하고 API 키는 서버에 둔다.
2. 게임·상품·수량·금액·지갑을 표시하고 이용자 승인을 받는다. 결제 객체의 배포와 지갑 네트워크가 일치해야 한다.
3. 응답의 `authorization`과 `permit`을 각각 EIP-712로 서명한다. 도메인·최소 단위 금액·nonce·배포 정보를 화면에서 다시 조합하지 않고 반환된 내용을 사용한다. 현재 지원 범위는 일반 EVM 개인키 지갑이다.
4. 게임 서버가 같은 주문·게임 세션인지 확인한 뒤 **게임 API 키**와 `Idempotency-Key`로 `POST /payments/{paymentId}/authorizations`를 보낸다. Metanomic은 주문의 payer가 결제 내용을 서명했는지 검증한다. 다른 게임 키나 서명 없는 요청은 거절한다. 포털에 이미 로그인한 이용자는 본인 지갑의 같은 결제를 포털에서도 승인할 수 있다.

```json
{
  "signature": "0x결제내용서명",
  "permitSignature": "0x토큰사용승인서명",
  "permitDeadline": 1792368000
}
```

`permitDeadline`에는 예시 숫자 대신 **해당 응답의 `expiresAt`을 그대로** 넣는다. 결제의 `expiresAt`, `claimBy`는 Unix 초이며, 지갑 연결 challenge의 `expiresAt`은 Unix 밀리초다. 서명 값은 실제 지갑 서명으로 교체한다. 응답은 `202`와 `operationId`이며 완료 보장이 아니다.

이미 서명한 동일 요청의 통신 재시도에는 같은 키·본문을 사용한다. permit nonce 충돌 등으로 작업이 확실히 실패하고 아직 결제 가능한 경우, 같은 `paymentId`를 다시 조회해 새 서명을 받고 **새 승인 요청 키**로 제출한다. 바뀐 서명 본문에 예전 요청 키를 재사용하면 409다. 새 주문이나 결제 ID를 만들지 않는다.

서명 UI는 [web/app.ts](../web/app.ts)의 `signTyped`와 결제 승인 처리를 참고한다. 게임 서버는 [src/game.ts](../src/game.ts)의 주문 조회·서명 중계처럼 본인 주문인지 먼저 확인한다. 별도 포털 가입이나 계정 연결 코드를 추가하지 않는다. `GET /games/{gameId}/payments?orderId=...`는 종료된 주문까지 업무 참조로 복구 조회할 수 있다.

## 7. 결제 확정부터 아이템 지급·정산까지

```text
CREATED → PROCESSING → PAID → DELIVERY_CLAIMED → COMPLETED
                         └─ 지급 시작 전 환불 → REFUNDED
```

| 확인 상태            | 게임 서버의 다음 처리                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| CREATED / PROCESSING | 승인·체인 결과를 기다린다. 아이템을 지급하지 않는다.                                                 |
| PAID                 | `POST /payments/{paymentId}/delivery-claims`에 `{}`와 안정적인 요청 키 `claim:{paymentId}`를 보낸다. |
| DELIVERY_CLAIMED     | 지급 시작이 확정된 상태다. 아래 DB 거래로 아이템을 지급하고 완료 통지를 보낸다.                      |
| COMPLETED            | 게임 예산에 판매 수입이 반영된 상태로 주문을 완료 표시한다.                                          |
| REFUNDED / EXPIRED   | 상품을 지급하지 않고 로컬 주문 상태를 맞춘다.                                                        |

지급 시작 요청이 `202`라고 즉시 아이템을 주지 않는다. 해당 작업의 `FINALIZED`와 현재 결제 상태 `DELIVERY_CLAIMED`를 확인한다. `PAID`에서는 환불과 지급 시작이 경쟁할 수 있다.

아이템 지급은 게임 DB의 한 트랜잭션으로 수행한다.

1. 로컬 주문·이용자와 결제의 `gameId`, `payer`, `orderId`, `assetId`, `amount`, `item`이 맞는지 확인한다.
2. `paymentId`가 유일한 지급 기록을 조회하고, 이미 지급됐다면 추가 아이템을 생성하지 않는다.
3. 지급 금지 복구 잠금이 있다면 지급하지 않는다.
4. 아이템 인벤토리 변경과 지급 성공 기록을 함께 커밋한다.

커밋 후 `POST /payments/{paymentId}/fulfillments`에 다음 본문과 키 `fulfill:{paymentId}`를 보낸다.

```json
{
  "deliveryRef": "delivery:반환된-paymentId"
}
```

완료 통지는 재시도할 수 있다. 아이템 지급 후 서버가 중단됐다면 지급 기록을 확인해 추가 아이템 없이 완료 통지만 재전송한다. `COMPLETED`가 되면 보관 코인이 해당 게임 예산으로 정산된다.

`PAID` 환불 API는 `POST /payments/{paymentId}/refunds`이며 본문은 `{}`다. `DELIVERY_CLAIMED` 이후에는 자동 환불하지 않는다. 미지급 확인·지급 금지 잠금·공동 승인에 의한 예외 복구는 [설계 명세](DESIGN.md)와 [README의 복구 절차](../README.md#지급-중단-복구)를 따른다. 게임 DB가 아닌 외부 인벤토리 서비스를 쓴다면 그 서비스도 동일한 지급 ID로 중복 방지를 제공해야 한다.

## 8. 영속 데이터와 폴링·재시작 복구

게임 DB에 최소한 다음을 저장한다. 기존 테이블·작업 큐가 있으면 그대로 확장한다.

| 저장 내용               | 제약·용도                                                        |
| ----------------------- | ---------------------------------------------------------------- |
| 게임 계정과 검증한 지갑 | 자체 로그인 세션의 지갑 주소·점수·인벤토리 관계를 영속 저장      |
| 보상 요청               | rewardRef 유일, 고정 본문·요청 키·rewardId·operationId·진행 상태 |
| 주문                    | orderId 유일, 서버 확정 가격·상품·계정·paymentId                 |
| 아이템 지급 기록        | paymentId 유일, 지급 결과와 deliveryRef                          |
| 작업 처리 위치          | 마지막 처리 이벤트 cursor와 재시도할 업무                        |

게임 서버에서 초기에는 약 1초 간격의 단일 폴링 작업을 실행할 수 있다. 한 번의 순회가 겹치지 않도록 한다. 이벤트 조회는 최대 100건씩 반환한다.

```http
GET /v1/games/game-1a2b3c4d/events?cursor=0
Authorization: Bearer <게임 자격증명>
```

응답은 `{ events: [{ eventId, type, resourceId, payload, cursor }], nextCursor }`다. 이벤트는 중복 전달될 수 있다고 가정하고, 처리 후에만 커서를 영속 저장한다. 이벤트의 과거 상태로 현재 결제 상태를 되돌리지 않는다.

시작·재시작과 주기적 복구에서는 다음 목록을 `cursor=0`부터 끝까지 조회한다.

```http
GET /v1/games/game-1a2b3c4d/payments?status=PAID,DELIVERY_CLAIMED&cursor=0&limit=50
Authorization: Bearer <게임 자격증명>
```

응답은 `{ payments, nextCursor }`이며 비어 있는 페이지까지 `nextCursor`로 순회한다. 이 조회 커서는 이벤트 커서와 별개다. 주문 화면의 종료·만료 상태 동기화에는 저장된 `paymentId`의 개별 조회도 사용한다. [예제 게임의 tick과 grant](../src/game.ts)가 실제 복구 흐름을 구현한다.

## 9. 요청 키·오류·대기 시간

업무 변경 요청에는 OpenAPI에 정의된 `Idempotency-Key`를 보낸다. 동일 주체·경로의 같은 키와 같은 본문은 기존 결과, 같은 키와 다른 본문은 409다. 보상·주문은 별도로 업무 참조까지 중복 검사한다. 예를 들어 `"4"`와 `"4.000000"`도 재시도 본문에서는 변경하지 않는다. 기존 요청을 보존한다.

| 상황                                                   | 처리                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 401 UNAUTHENTICATED                                    | 세션 만료·자격증명 폐기를 확인한다. 무한 재시도하지 않는다.                     |
| 403 ROLE_DENIED / GAME_ACCESS_DENIED                   | 인증 주체·게임 ID·자격증명 범위를 확인한다.                                     |
| 403 ORIGIN_DENIED                                      | 공통 화면 origin과 외부 게임의 요청 경계를 확인한다.                            |
| 409 IDEMPOTENCY_CONFLICT / BUSINESS_REFERENCE_CONFLICT | 저장된 요청과 재요청 내용의 차이를 확인한다. 중복 회피용 새 ID를 만들지 않는다. |
| 409 BUDGET_EXCEEDED                                    | 예산·예약을 확인하고 예산을 확보한다.                                           |
| 409 INVALID_PAYMENT_STATE / PAYMENT_NOT_PAYABLE        | 결제를 재조회하고 현재 상태·만료에 맞춰 처리한다.                               |
| 422                                                    | 입력 형식, 계정·지갑 연결, 서명과 만료를 확인한다.                              |
| 타임아웃·503·일시 통신 실패                            | 지연을 두고 기존 업무·작업을 조회한다. 키·본문을 유지해 재시도한다.             |

작업은 `QUEUED → PREPARED → SUBMITTED → INCLUDED → FINALIZED`다. `RECONCILING`은 결과 확인 중이며 실패가 아니다. `FAILED`만 확실한 실패다. 접수·포함 상태에서 완료로 표시하지 않는다.

Saigon은 실제 검증에서 최종 확정까지 약 20~30분을 관측했다. 이는 보장 시간이 아니다. 중계기는 이전 거래가 블록에 포함되면(수 초) 다음 거래를 보내므로 요청이 줄지어 밀리지는 않지만, 보상·결제의 업무 결과(`FINALIZED`, `PAID`, `COMPLETED`)는 최종 확정 후에 반영된다. 예외로 관리자 예산 배분은 블록 포함 즉시 사용 가능 예산에 더해진다. 게임 UI는 "접수됨 → 처리 중 → 완료"를 구분하고, 짧은 화면 대기 종료를 실패로 바꾸지 않고 영속 작업에서 추적한다. 로컬 확인과 테스트넷 확인 결과를 구분한다.

## 10. 연동 완료 기준

- 게임 지갑 로그인만으로 보상·결제가 동작한다. 포털 사전 가입·게임별 연결 코드 없이 주소로 지급하고, 보상·주문 주소는 인증된 게임 세션에서 정한다. 포털은 첫 로그인 이후 이전 주소 기반 내역도 보여준다.
- 예산에서 10코인을 지급하고 같은 요청·다른 요청 키의 같은 rewardRef 재요청 모두 추가 지급이 없다.
- 게임 서버가 확정한 4코인 주문을 이용자가 서명하고, 서명 없이 또는 금액·게임을 바꿔 결제할 수 없다.
- 지급 시작 확정 전에는 아이템이 없고, 확정 후 정확히 하나 생성된다.
- 아이템 지급 직후·완료 통지 전에 서버를 중단해도 재시작 후 아이템은 하나이며 결제는 COMPLETED가 된다.
- 결제 수입으로 게임 예산이 4코인 증가하고 그중 1코인을 다시 보상할 수 있다.
- 환불이 먼저 확정되면 아이템을 지급하지 않는다. 지급 시작 후에는 자동 환불하지 않는다.
- API 키가 브라우저 산출물·응답·로그에 노출되지 않는다.
- UI가 접수·확정·아이템 지급을 구분하며, 실패·재시도·복구 중 상태를 표시한다.

같은 저장소를 변경했다면 해당 변경에 맞는 검사와 기존 `npm run check`를 실행한다. UI 변경에는 `npm run build:web`와 실제 브라우저 확인을 추가한다. 테스트는 격리된 DB·체인을 사용하고 사용 중인 개발 DB를 초기화하지 않는다. 타 게임 저장소에서는 해당 프로젝트 검사와 위 API 통합 시나리오를 실행한다. [에이전트 작업 템플릿](AGENT_GAME_INTEGRATION_TASK.md)에 결과를 보고하는 형식까지 정리되어 있다.
