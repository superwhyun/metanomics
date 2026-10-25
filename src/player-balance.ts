import type { Address } from "viem";
import type { ChainAdapter } from "./chain.js";
import { display } from "./shared.js";

// Display snapshots only. Worker finality, payment authorization and accounting
// continue to use their own finalized reads.
export async function playerBalance(
  adapter: Pick<ChainAdapter, "latestBlock" | "finalBlock" | "getBalance">,
  address: Address,
) {
  const read = async (block: () => Promise<any>) => {
    const snapshot = await block();
    return {
      number: BigInt(snapshot.number),
      value: await adapter.getBalance(address, snapshot.number),
    };
  };
  const [latestResult, finalizedResult] = await Promise.allSettled([
    read(() => adapter.latestBlock()),
    read(() => adapter.finalBlock()),
  ]);
  let latest =
    latestResult.status === "fulfilled" ? latestResult.value : undefined;
  const finalized =
    finalizedResult.status === "fulfilled" ? finalizedResult.value : undefined;
  // Finality can advance while the two RPC reads are in flight. A newer final
  // snapshot is also a valid observed balance; never call an older snapshot latest.
  if (latest && finalized && finalized.number > latest.number)
    latest = finalized;
  let pendingDelta: string | undefined;
  if (latest && finalized) {
    const difference = latest.value - finalized.value;
    pendingDelta =
      difference < 0n ? `-${display(-difference)}` : display(difference);
  }
  return {
    ...(latest
      ? {
          latestAmount: display(latest.value),
          latestBlockNumber: latest.number.toString(),
        }
      : {}),
    // Preserve the existing amount/blockNumber contract for existing API clients.
    ...(finalized
      ? {
          amount: display(finalized.value),
          blockNumber: finalized.number.toString(),
        }
      : {}),
    ...(pendingDelta !== undefined ? { pendingDelta } : {}),
    finalized: Boolean(finalized),
    latestUnavailable: !latest,
    finalityUnavailable: !finalized,
  };
}
