import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { startLocalChain } from "../scripts/local-chain.js";
import { DEVELOPMENT_MNEMONIC } from "../src/provision.js";
import { freePort } from "./helpers.js";

test("persistent local node bounds history and restores balances, receipts and recent historical reads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "metanomic-persistent-"));
  const statePath = join(dir, "state.json");
  let chain = await startLocalChain(await freePort(), statePath);
  t.after(async () => {
    if (chain.child.exitCode === null && chain.child.signalCode === null) {
      const stopped = once(chain.child, "exit");
      chain.child.kill("SIGTERM");
      await stopped;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await chain.client.request({
    method: "anvil_mine",
    params: ["0x320"],
  } as any);
  const account = mnemonicToAccount(DEVELOPMENT_MNEMONIC);
  const recipient = "0x1000000000000000000000000000000000000001";
  const signer = createWalletClient({ account, transport: http(chain.url) });
  const hash = await signer.sendTransaction({
    chain: null,
    to: recipient,
    value: 123n,
  });
  const receipt = await chain.client.getTransactionReceipt({ hash });
  // Mine another block so the transfer's state is a historical read after restart.
  await chain.client.request({ method: "anvil_mine", params: ["0x1"] } as any);
  const tip = await chain.client.getBlock();
  assert.equal(await chain.client.getBalance({ address: recipient }), 123n);
  const stopped = once(chain.child, "exit");
  chain.child.kill("SIGTERM");
  await stopped;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(state.historical_states);
  assert.ok(
    state.historical_states.length <= 628,
    "historical cache must stay bounded",
  );
  chain = await startLocalChain(await freePort(), statePath);
  assert.equal((await chain.client.getBlock()).hash, tip.hash);
  assert.equal(await chain.client.getBalance({ address: recipient }), 123n);
  assert.equal(
    await chain.client.getBalance({
      address: recipient,
      blockNumber: receipt.blockNumber,
    }),
    123n,
  );
  assert.equal(
    (await chain.client.getTransactionReceipt({ hash })).blockHash,
    receipt.blockHash,
  );
});
