export type PlayerBalance = {
  amount?: string;
  latestAmount?: string;
  pendingDelta?: string;
  walletRequired?: boolean;
};
const format = (amount: string) =>
  Number(amount).toLocaleString("ko-KR", { maximumFractionDigits: 6 });

export function renderPlayerBalance(
  container: HTMLElement,
  balance?: PlayerBalance,
) {
  const value = container.querySelector<HTMLElement>("#balance")!;
  const label = container.querySelector<HTMLElement>("#balance-kind")!;
  const finalized = container.querySelector<HTMLElement>("#balance-finalized")!;
  const pending = container.querySelector<HTMLElement>("#balance-pending")!;
  pending.textContent = "";
  pending.classList.add("hidden");
  if (!balance || balance.walletRequired) {
    value.textContent = "—";
    label.textContent = "CGC";
    finalized.textContent = balance?.walletRequired
      ? "지갑으로 로그인하면 내 잔액을 확인할 수 있습니다."
      : "잔액 확인 중";
    return;
  }
  if (balance.latestAmount !== undefined) {
    value.textContent = format(balance.latestAmount);
    label.textContent = "CGC · 최신 잔액";
    finalized.textContent =
      balance.amount !== undefined
        ? `최종 확정 ${format(balance.amount)} CGC`
        : "최종 확정 잔액 조회 불가";
    if (
      balance.pendingDelta !== undefined &&
      Number(balance.pendingDelta) !== 0
    ) {
      pending.textContent = `확정 전 변동 ${Number(balance.pendingDelta) > 0 ? "+" : ""}${format(balance.pendingDelta)} CGC`;
      pending.classList.remove("hidden");
    } else if (balance.amount === undefined) {
      pending.textContent = "확정 전 변동을 계산할 수 없습니다.";
      pending.classList.remove("hidden");
    }
  } else if (balance.amount !== undefined) {
    value.textContent = format(balance.amount);
    label.textContent = "CGC · 확정 잔액";
    finalized.textContent = "최신 잔액 조회 불가 · 확정 잔액을 표시합니다.";
  } else {
    value.textContent = "—";
    label.textContent = "CGC";
    finalized.textContent =
      "잔액을 확인하지 못했습니다. 잠시 후 새로고침하세요.";
  }
}
