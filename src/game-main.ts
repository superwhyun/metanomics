import { loadRuntime } from "./runtime.js";
import { DemoGame, NetworkClient } from "./game.js";
import { ASSET } from "./shared.js";
const gameId = process.env.GAME_ID as "game-a" | "game-b";
if (!["game-a", "game-b"].includes(gameId))
  throw new Error("GAME_ID must be game-a or game-b");
const config = loadRuntime();
const game = new DemoGame(
  gameId,
  process.env.GAME_DATABASE_PATH ?? `var/${gameId}.sqlite`,
  new NetworkClient(
    process.env.NETWORK_URL ?? "http://127.0.0.1:3300",
    config.credentials[gameId],
  ),
  process.env.GAME_PLAYER_PASSWORD ?? "pilot-dev",
);
const asset = (await game.network.call("/assets")).assets.find(
  (a: any) => a.assetId === ASSET,
);
const deployment = asset?.deployments.find(
  (d: any) => d.id === asset.activeDeploymentId,
);
if (!deployment) throw new Error("게임 로그인에 사용할 배포 설정이 없습니다.");
const app = await game.app({
  origin:
    process.env.GAME_ORIGIN ?? `http://127.0.0.1:${process.env.GAME_PORT}`,
  chainId: deployment.chainId,
});
const timer = setInterval(() => void game.tick(), 1000);
await app.listen({ port: Number(process.env.GAME_PORT), host: "127.0.0.1" });
async function close() {
  clearInterval(timer);
  await app.close();
  while (game.busy) await new Promise((r) => setTimeout(r, 25));
  game.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
