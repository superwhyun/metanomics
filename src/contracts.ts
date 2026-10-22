import { readFileSync } from "node:fs";
export const artifact = (
  name: "CommonCredit" | "Settlement",
): { abi: any; bytecode: `0x${string}` } =>
  JSON.parse(
    readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8"),
  );
