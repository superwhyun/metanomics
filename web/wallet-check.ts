import { toHex, verifyMessage, getAddress, type Hex } from "viem";
import { WalletDiscovery, type WalletProvider } from "./wallet.js";
const choices = document.querySelector<HTMLElement>("#check-wallets")!;
const result = document.querySelector<HTMLElement>("#check-result")!;
const steps = document.querySelector<HTMLElement>("#check-steps")!;
const discovery = new WalletDiscovery(window);
const step = (message: string) => {
  const item = document.createElement("li");
  item.textContent = message;
  steps.append(item);
};
async function check(provider: WalletProvider, name: string) {
  const buttons = choices.querySelectorAll<HTMLButtonElement>("button");
  for (const button of buttons) button.disabled = true;
  steps.replaceChildren();
  result.textContent = "지갑 응답을 확인하고 있습니다.";
  try {
    step(`${name}: 연결 승인 요청`);
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
      throw new Error("연결할 계정이 반환되지 않았습니다.");
    const address = getAddress(accounts[0]);
    step(`계정 반환 성공: ${address}`);
    const message = `Metanomic wallet diagnostic\nOrigin: ${location.origin}\nNonce: ${crypto.randomUUID()}\nPurpose: check message signing only.\nNo login, transaction, token approval, or account linking.`;
    step("personal_sign 요청: 지갑에서 진단 메시지를 확인하세요.");
    const signature = await provider.request({
      method: "personal_sign",
      params: [toHex(message), address],
    });
    if (typeof signature !== "string")
      throw new Error("서명값이 문자열이 아닙니다.");
    const valid = await verifyMessage({
      address,
      message,
      signature: signature as Hex,
    });
    if (!valid) throw new Error("반환된 서명이 요청 계정과 일치하지 않습니다.");
    step("서명값 반환 및 암호학적 검증 성공");
    result.textContent = "서명 확인 성공. 지갑이 유효한 서명값을 반환했습니다.";
  } catch (error: any) {
    const fields: string[] = [];
    const seen = new Set<unknown>();
    function describe(value: any, depth = 0) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 6)
        return;
      seen.add(value);
      if (value.code !== undefined) fields.push(`code=${String(value.code)}`);
      if (typeof value.message === "string")
        fields.push(value.message.slice(0, 500));
      for (const inner of [
        value.data,
        value.cause,
        value.originalError,
        value.error,
      ])
        describe(inner, depth + 1);
    }
    describe(error);
    step(fields.join(" · "));
    result.textContent =
      "서명 확인 실패. 위 단계와 지갑이 반환한 원문 오류를 확인하세요.";
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}
function render() {
  if (choices.querySelector("button:disabled")) return;
  choices.replaceChildren();
  for (const wallet of discovery.wallets()) {
    const button = document.createElement("button");
    button.className = "primary";
    button.textContent = `${wallet.name} 서명 확인`;
    button.addEventListener(
      "click",
      () => void check(wallet.provider, wallet.name),
    );
    choices.append(button);
  }
  if (!choices.children.length)
    choices.textContent = "지갑 확장 프로그램을 찾지 못했습니다.";
}
window.addEventListener("eip6963:announceProvider", render);
discovery.request();
render();
