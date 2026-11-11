import {
  WalletDiscovery,
  assertWalletSession,
  connectInjectedWallet,
  walletErrorMessage,
  type WalletProvider,
} from "./wallet.js";
import { randomUUID } from "./random.js";

// Hosted payment page. The game server creates a checkout session and sends the
// payer here with the session token in the URL fragment; the page shows the
// order, collects the payer's two signatures and returns to the game.
const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const token = location.hash.slice(1);
const discovery = new WalletDiscovery(window);
let checkout: any;
let busy = false;

function status(message: string, error = false) {
  const el = $("#checkout-status");
  el.textContent = message;
  el.classList.toggle("error", error);
}
async function api(path: string, body?: unknown) {
  const response = await fetch(
    `/v1/checkout/${encodeURIComponent(token)}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      result.error?.message ?? "결제 요청을 처리하지 못했습니다.",
    );
  return result;
}
function back(url: string, state: "submitted" | "cancelled") {
  const target = new URL(url);
  target.searchParams.set("paymentId", checkout.payment.paymentId);
  target.searchParams.set("orderId", checkout.payment.orderId);
  target.searchParams.set("checkout", state);
  return target.href;
}
const formatAmount = (value: string) =>
  value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");

async function signTyped(
  provider: WalletProvider,
  address: string,
  request: any,
) {
  await assertWalletSession(provider, address, checkout.network.chainId);
  if (Number(request.domain.chainId) !== checkout.network.chainId)
    throw new Error(
      "결제 네트워크가 다릅니다. 게임에서 결제를 다시 시작하세요.",
    );
  const EIP712Domain = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [
      address,
      JSON.stringify({ ...request, types: { EIP712Domain, ...request.types } }),
    ],
  });
}

async function pay(provider: WalletProvider) {
  if (busy) return;
  busy = true;
  const buttons = $("#checkout-wallets").querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const payer = String(checkout.payment.payer);
    status("지갑 연결을 확인하는 중…");
    const address = await connectInjectedWallet(provider, checkout.network, {
      chooseAccount: async (accounts) =>
        accounts.find((a) => a.toLowerCase() === payer.toLowerCase()) ??
        accounts[0],
    });
    if (address.toLowerCase() !== payer.toLowerCase())
      throw new Error(
        `이 주문은 ${payer} 지갑으로만 결제할 수 있습니다. 지갑에서 해당 계정을 선택한 뒤 다시 시도하세요.`,
      );
    // Reload so the token-use approval carries the wallet's current permit nonce.
    checkout = await api("");
    if (checkout.payment.status !== "CREATED") return render();
    status("1/2 지갑에서 결제 승인 서명을 확인하세요.");
    const signature = await signTyped(
      provider,
      address,
      checkout.payment.authorization,
    );
    status("2/2 지갑에서 CGC 사용 승인 서명을 확인하세요.");
    const permitSignature = await signTyped(
      provider,
      address,
      checkout.payment.permit,
    );
    status("결제를 제출하는 중…");
    await api("/authorizations", {
      signature,
      permitSignature,
      permitDeadline: checkout.payment.expiresAt,
    });
    $("#checkout-wallets").replaceChildren();
    $("#checkout-cancel").hidden = true;
    status("결제를 접수했습니다. 게임으로 돌아갑니다…");
    setTimeout(
      () => location.assign(back(checkout.returnUrl, "submitted")),
      1500,
    );
  } catch (error) {
    status(walletErrorMessage(error), true);
    buttons.forEach((b) => (b.disabled = false));
  } finally {
    busy = false;
  }
}

function renderWallets() {
  const list = $("#checkout-wallets");
  const wallets = discovery.wallets();
  list.replaceChildren();
  if (!wallets.length) {
    status(
      "브라우저에서 지갑을 찾지 못했습니다. Ronin Wallet 같은 EVM 지갑 확장 프로그램을 설치하거나 잠금을 해제한 뒤 새로고침하세요.",
      true,
    );
    return;
  }
  for (const wallet of wallets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    button.textContent = `${wallet.name}으로 결제`;
    button.addEventListener("click", () => void pay(wallet.provider));
    list.append(button);
  }
  status("");
}

const STATE_MESSAGES: Record<string, string> = {
  PROCESSING: "이미 결제를 접수했습니다. 게임에서 지급 상태를 확인하세요.",
  PAID: "결제가 완료되었습니다. 게임에서 아이템 지급을 확인하세요.",
  DELIVERY_CLAIMED: "결제가 완료되어 아이템을 지급하고 있습니다.",
  COMPLETED: "결제와 아이템 지급이 완료되었습니다.",
  REFUNDED: "환불된 주문입니다.",
  EXPIRED: "결제 가능 시간이 지났습니다. 게임에서 다시 주문하세요.",
};

function render() {
  const { payment, gameName } = checkout;
  $("#checkout-game").textContent = gameName ?? payment.gameId;
  $("#checkout-title").textContent = `${payment.item.name} 결제`;
  $("#checkout-item").textContent =
    `${payment.item.name} × ${payment.item.quantity}`;
  $("#checkout-amount").textContent = formatAmount(payment.amount);
  $("#checkout-payer").textContent = payment.payer;
  $("#checkout-expiry").textContent =
    `${new Date(payment.expiresAt * 1000).toLocaleString("ko-KR")}까지`;
  $("#checkout-summary").hidden = false;
  const cancel = $("#checkout-cancel");
  const expired = payment.expiresAt * 1000 < Date.now();
  if (payment.status !== "CREATED" || expired) {
    $("#checkout-wallets").replaceChildren();
    $("#checkout-note").hidden = true;
    status(
      STATE_MESSAGES[
        expired && payment.status === "CREATED" ? "EXPIRED" : payment.status
      ] ?? payment.status,
    );
    cancel.hidden = false;
    cancel.textContent = "게임으로 돌아가기";
    cancel.onclick = () =>
      location.assign(
        back(
          payment.status === "CREATED"
            ? checkout.cancelUrl
            : checkout.returnUrl,
          payment.status === "CREATED" ? "cancelled" : "submitted",
        ),
      );
    return;
  }
  $("#checkout-note").hidden = false;
  cancel.hidden = false;
  cancel.onclick = () => location.assign(back(checkout.cancelUrl, "cancelled"));
  // Wallet extensions may announce themselves shortly after load.
  renderWallets();
  setTimeout(() => {
    if (!busy) renderWallets();
  }, 400);
}

async function main() {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    $("#checkout-title").textContent = "결제 링크가 올바르지 않습니다";
    status("게임으로 돌아가 결제를 다시 시작하세요.", true);
    return;
  }
  try {
    checkout = await api("");
  } catch (error) {
    $("#checkout-title").textContent = "결제 정보를 불러오지 못했습니다";
    status(error instanceof Error ? error.message : String(error), true);
    return;
  }
  render();
}
void main();
