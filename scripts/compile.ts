import solc from "solc";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function compile() {
  const sources = Object.fromEntries(
    ["CommonCredit", "Settlement"].map((n) => [
      `${n}.sol`,
      { content: readFileSync(`contracts/${n}.sol`, "utf8") },
    ]),
  );
  const result = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "cancun",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
      {
        import: (name: string) => {
          try {
            return {
              contents: readFileSync(resolve("node_modules", name), "utf8"),
            };
          } catch {
            return { error: `Import not found: ${name}` };
          }
        },
      },
    ),
  );
  const errors = (result.errors ?? []).filter(
    (e: any) => e.severity === "error",
  );
  if (errors.length)
    throw new Error(errors.map((e: any) => e.formattedMessage).join("\n"));
  mkdirSync("artifacts", { recursive: true });
  for (const n of ["CommonCredit", "Settlement"]) {
    const c = result.contracts[`${n}.sol`][n];
    writeFileSync(
      `artifacts/${n}.json`,
      JSON.stringify(
        { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` },
        null,
        2,
      ),
    );
  }
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  compile();
  process.stdout.write("Contracts compiled (Solidity, Cancun EVM).\n");
}
