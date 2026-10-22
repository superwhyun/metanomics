import { DemoGame, NetworkClient } from "../src/game.js";
const [gameId, paymentId, evidenceHash] = process.argv.slice(2);
if (
  !["game-a", "game-b"].includes(gameId) ||
  !paymentId ||
  !/^0x[0-9a-fA-F]{64}$/.test(evidenceHash ?? "")
)
  throw new Error(
    "Usage: npx tsx scripts/recovery-lock.ts game-b payment-ID 0xEVIDENCE_HASH",
  );
const game = new DemoGame(
  gameId as any,
  process.env.GAME_DATABASE_PATH ?? `var/${gameId}.sqlite`,
  new NetworkClient("", ""),
);
try {
  process.stdout.write(
    JSON.stringify(game.blockForRecovery(paymentId, evidenceHash)) + "\n",
  );
} finally {
  game.close();
}
