# @metanomic/game-sdk

Metanomic 게임 서버용 SDK입니다. 보상, 주문·결제, 호스팅 결제창, 아이템 지급, 이벤트, 웹훅 서명 검증을 다룹니다. 게임 API 키를 사용하므로 **게임 서버에서만** 사용하세요. Node.js 22 이상이 필요하며 다른 의존성은 없습니다.

전체 연동 흐름과 상태 규칙은 [게임 개발자 연동 가이드](../docs/GAME_INTEGRATION.md)를 따릅니다.

## 설치

아직 npm 레지스트리에 공개하지 않았습니다. 저장소에서 빌드해 설치합니다.

```sh
cd /path/to/metanomic && npm run sdk:build
cd /path/to/your-game && npm install /path/to/metanomic/sdk
```

## 설정

운영자 포털 **게임 서버 연결**에서 복사한 환경 변수를 사용합니다.

```js
import { Metanomic } from "@metanomic/game-sdk";

// METANOMIC_API_URL, METANOMIC_GAME_ID, METANOMIC_GAME_KEY, (선택) METANOMIC_ASSET_ID
const metanomic = Metanomic.fromEnv();
// 또는 new Metanomic({ apiUrl, gameId, apiKey, timeoutMs?, maxRetries? })
```

모든 변경 요청에는 업무 참조로 만든 `Idempotency-Key`가 자동으로 붙습니다. 통신 오류·429·5xx는 같은 키로 재시도(기본 2회)하므로 중복 지급·중복 주문이 생기지 않습니다.

## 보상

```js
const accepted = await metanomic.rewards.create({
  recipient: session.wallet, // 게임 지갑 로그인으로 검증한 주소
  amount: "10.000000", // 소수점 6자리 이하 문자열
  rewardRef: `weekly:2026-W46:${account.id}`, // 같은 값은 한 번만 지급
});
// accepted: { rewardId, operationId, status } — 접수(202)이며 완료가 아님

const reward = await metanomic.rewards.get(rewardRef); // 응답 유실 복구
await metanomic.operations.wait(accepted.operationId); // FINALIZED/FAILED까지 대기
```

## 결제 (호스팅 결제창)

```js
const payment = await metanomic.payments.create({
  payer: session.wallet,
  orderId: order.id, // 같은 orderId는 같은 결제를 반환
  amount: "4.000000", // 서버에서 확정한 가격
  item: { sku: "starter-pass", name: "초보자 이용권", quantity: 1 },
});
const checkout = await metanomic.payments.checkout(payment.paymentId, {
  returnUrl: "https://game.example/shop",
  cancelUrl: "https://game.example/shop", // 생략하면 returnUrl
});
res.redirect(checkout.url);
```

이용자는 결제창에서 지갑으로 서명한 뒤 `returnUrl?paymentId=…&orderId=…&checkout=submitted`로 돌아옵니다. 이는 접수일 뿐이므로 `payments.get()`이나 웹훅으로 `PAID`를 확인한 뒤 아이템을 지급하세요.

결제 서명 화면을 직접 만들었다면 `payments.get(paymentId)`의 `authorization`·`permit`을 서명받아 `payments.authorize(paymentId, { signature, permitSignature, permitDeadline })`로 중계합니다.

## 아이템 지급

```js
for await (const pay of metanomic.payments.all(["PAID", "DELIVERY_CLAIMED"])) {
  if (pay.status === "PAID") {
    await metanomic.payments.claimDelivery(pay.paymentId);
    continue; // 작업이 FINALIZED되어 DELIVERY_CLAIMED가 되면 다음 순회에서 지급
  }
  grantOnce(pay); // paymentId 유일 제약으로 게임 DB에 한 번만 지급
  await metanomic.payments.fulfill(pay.paymentId, `delivery:${pay.paymentId}`);
}
```

`payments.refund(paymentId)`는 지급 시작 전(`PAID`)에만 사용할 수 있습니다.

## 웹훅

운영자가 포털에서 웹훅을 등록하면 한 번만 표시되는 서명 비밀값(`whsec_…`)을 받습니다.

```js
import express from "express";
import { verifyWebhook } from "@metanomic/game-sdk";

app.post(
  "/metanomic/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = verifyWebhook(
        req.body, // 파싱 전 원문
        req.get("metanomic-signature"),
        process.env.METANOMIC_WEBHOOK_SECRET,
      );
    } catch {
      return res.sendStatus(401);
    }
    queue.push(event); // eventId로 중복 제거, 상태는 다시 조회
    res.sendStatus(204);
  },
);
```

같은 이벤트가 두 번 올 수 있고, 실패하면 백오프로 재시도합니다. 웹훅을 쓰더라도 재시작 복구용 `payments.all()` 순회는 유지하세요.

## 오류

```js
import { MetanomicError } from "@metanomic/game-sdk";

try {
  await metanomic.rewards.create(input);
} catch (error) {
  if (error instanceof MetanomicError) {
    error.status; // HTTP 상태, 통신 오류는 0
    error.code; // 예: BUDGET_EXCEEDED, BUSINESS_REFERENCE_CONFLICT
    error.retryable; // true면 같은 입력으로 나중에 다시 호출
  }
}
```

## API 목록

| 메서드                                            | HTTP                                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| `budget()`                                        | `GET /games/{gameId}/budget`                              |
| `rewards.create/get/list`                         | `POST·GET /games/{gameId}/rewards`                        |
| `payments.create/get/findByOrderId/list/all`      | `POST·GET /games/{gameId}/payments`, `GET /payments/{id}` |
| `payments.checkout`                               | `POST /payments/{id}/checkout-sessions`                   |
| `payments.authorize/claimDelivery/fulfill/refund` | `POST /payments/{id}/…`                                   |
| `events.list(cursor)`                             | `GET /games/{gameId}/events`                              |
| `operations.get/wait`                             | `GET /operations/{id}`                                    |
| `verifyWebhook(rawBody, header, secret)`          | 웹훅 서명 검증                                            |
