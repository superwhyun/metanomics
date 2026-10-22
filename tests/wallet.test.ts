import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WalletDiscovery,
  assertWalletSession,
  connectInjectedWallet,
  walletErrorMessage,
  revokeWalletConnection,
  type WalletProvider,
} from "../web/wallet.js";

test("Ronin nested lock errors explain unlocking instead of reporting a generic RPC error", () => {
  const error = {
    code: -32603,
    message: "Internal JSON-RPC error.",
    data: {
      cause: {
        code: "WALLET_IS_LOCKED",
        message: "Please unlock wallet first!",
      },
    },
  };
  assert.match(walletErrorMessage(error), /잠금을 해제/);
  assert.match(walletErrorMessage(error), /서명값을 반환하지 못했습니다/);
  assert.match(walletErrorMessage(error), /한 번 잠근 뒤/);
  assert.match(walletErrorMessage({ cause: error }), /잠금을 해제/);
  assert.match(walletErrorMessage({ code: 4001 }), /취소/);
  assert.match(walletErrorMessage({ code: -32002 }), /처리 중인 요청/);
  assert.equal(
    walletErrorMessage(new Error("Unexpected failure")),
    "Unexpected failure",
  );
  const cyclic: any = { message: "Cycle" };
  cyclic.cause = cyclic;
  assert.equal(walletErrorMessage(cyclic), "Cycle");
});

const account = "0x0000000000000000000000000000000000000001";
const other = "0x0000000000000000000000000000000000000002";
const network = {
  id: "local",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  finality: "local",
};
class Host extends EventTarget {
  ronin?: { provider: WalletProvider };
  ethereum?: WalletProvider;
}
function wallet(initialChain = "0x7a69") {
  const calls: { method: string; params?: unknown[] }[] = [];
  let chain = initialChain;
  const provider: WalletProvider = {
    async request(args) {
      calls.push(args);
      if (
        args.method === "eth_requestAccounts" ||
        args.method === "eth_accounts"
      )
        return [account];
      if (args.method === "eth_chainId") return chain;
      if (args.method === "wallet_switchEthereumChain") {
        chain = (args.params![0] as any).chainId;
        return null;
      }
      return "signature";
    },
  };
  return { provider, calls };
}

test("Ronin-only extension is discovered without window.ethereum or prompting access", () => {
  const host = new Host();
  const ronin = wallet();
  host.ronin = { provider: ronin.provider };
  const discovery = new WalletDiscovery(host);
  assert.deepEqual(discovery.wallets(), [
    { name: "Ronin Wallet", provider: ronin.provider },
  ]);
  assert.equal(ronin.calls.length, 0);
  discovery.close();
});

test("EIP-6963 announcements coexist with legacy wallets, deduplicate providers and ignore malformed events", () => {
  const host = new Host();
  const ronin = wallet(),
    metamask = wallet();
  host.ronin = { provider: ronin.provider };
  host.ethereum = Object.assign(metamask.provider, { isMetaMask: true });
  const announce = () => {
    host.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            name: "Ronin Wallet",
            uuid: "ronin",
            rdns: "com.roninchain.wallet",
          },
          provider: ronin.provider,
        },
      }),
    );
  };
  host.addEventListener("eip6963:requestProvider", announce);
  const discovery = new WalletDiscovery(host);
  discovery.request();
  for (const detail of [null, {}, { provider: {}, info: { name: "bad" } }])
    host.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  const choices = discovery.wallets();
  assert.deepEqual(
    choices.map((w) => w.name),
    ["Ronin Wallet", "MetaMask"],
  );
  assert.equal(choices[0].provider, ronin.provider);
  assert.equal(choices[1].provider, metamask.provider);
  discovery.close();
  host.removeEventListener("eip6963:requestProvider", announce);
});

test("late-injected legacy providers are discovered on the next connection attempt", () => {
  const host = new Host();
  const discovery = new WalletDiscovery(host);
  assert.deepEqual(discovery.wallets(), []);
  host.ronin = { provider: wallet().provider };
  assert.equal(discovery.wallets()[0].name, "Ronin Wallet");
  discovery.close();
});

test("selected Ronin provider handles the account, network and subsequent signing without using another wallet", async () => {
  const ronin = wallet(),
    metamask = wallet();
  const host = new Host();
  host.ronin = { provider: ronin.provider };
  host.ethereum = metamask.provider;
  const discovery = new WalletDiscovery(host);
  const selected = discovery.wallets().find((w) => w.name === "Ronin Wallet")!;
  const address = await connectInjectedWallet(selected.provider, network);
  assert.equal(address, account);
  await assertWalletSession(selected.provider, address, network.chainId);
  await selected.provider.request({
    method: "personal_sign",
    params: ["message", address],
  });
  await selected.provider.request({
    method: "eth_signTypedData_v4",
    params: [address, "typed-data"],
  });
  assert.equal(metamask.calls.length, 0);
  assert.deepEqual(
    ronin.calls.slice(-2).map((c) => c.method),
    ["personal_sign", "eth_signTypedData_v4"],
  );
  discovery.close();
});

test("unknown network is added with local currency and explicitly switched before connection completes", async () => {
  const calls: any[] = [];
  let added = false,
    switched = false;
  const provider: WalletProvider = {
    async request(args) {
      calls.push(args);
      if (
        args.method === "eth_requestAccounts" ||
        args.method === "eth_accounts"
      )
        return [account];
      if (args.method === "wallet_switchEthereumChain") {
        if (!added)
          throw Object.assign(new Error("Unknown chain"), { code: 4902 });
        switched = true;
        return null;
      }
      if (args.method === "wallet_addEthereumChain") {
        added = true;
        return null;
      }
      if (args.method === "eth_chainId") return switched ? "0x7a69" : "0x1";
    },
  };
  await connectInjectedWallet(provider, network);
  assert.equal(
    calls.filter((c) => c.method === "wallet_switchEthereumChain").length,
    2,
  );
  assert.equal(
    calls.find((c) => c.method === "wallet_addEthereumChain").params[0]
      .nativeCurrency.symbol,
    "ETH",
  );
});

test("rejected network approval does not add a chain or complete connection", async () => {
  const provider = wallet("0x1");
  const request = provider.provider.request;
  provider.provider.request = async (args) => {
    if (args.method === "wallet_switchEthereumChain")
      throw Object.assign(new Error("User rejected"), { code: 4001 });
    return request(args);
  };
  await assert.rejects(
    connectInjectedWallet(provider.provider, network),
    /User rejected/,
  );
  assert.equal(
    provider.calls.some((c) => c.method === "wallet_addEthereumChain"),
    false,
  );
});

test("empty accounts, changed accounts and wrong networks cannot be used for signing", async () => {
  await assert.rejects(
    connectInjectedWallet({ request: async () => [] }, network),
    /계정을 선택/,
  );
  await assert.rejects(
    assertWalletSession({ request: async () => [other] }, account, 31337),
    /계정이 변경/,
  );
  await assert.rejects(
    assertWalletSession(
      {
        request: async ({ method }) =>
          method === "eth_accounts" ? [account] : "0x1",
      },
      account,
      31337,
    ),
    /네트워크가 다릅니다/,
  );
});

test("Ronin empty eth_accounts after connection is resolved through explicit account authorization", async () => {
  const calls: string[] = [];
  const provider: WalletProvider = {
    async request({ method }) {
      calls.push(method);
      if (method === "eth_accounts") return [];
      if (method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return "0x7a69";
      return null;
    },
  };
  assert.equal(await connectInjectedWallet(provider, network), account);
  await assertWalletSession(provider, account, network.chainId);
  assert.equal(calls.filter((m) => m === "eth_requestAccounts").length, 3);
});

test("empty passive accounts cannot bypass rejection, a locked wallet, account change or the wrong chain", async () => {
  for (const authorized of [[], [other]]) {
    await assert.rejects(
      assertWalletSession(
        {
          request: async ({ method }) =>
            method === "eth_accounts" ? [] : authorized,
        },
        account,
        network.chainId,
      ),
      /계정이 변경/,
    );
  }
  await assert.rejects(
    assertWalletSession(
      {
        request: async ({ method }) => {
          if (method === "eth_accounts") return [];
          throw Object.assign(new Error("User rejected authorization"), {
            code: 4001,
          });
        },
      },
      account,
      network.chainId,
    ),
    /User rejected authorization/,
  );
  await assert.rejects(
    assertWalletSession(
      {
        request: async ({ method }) => {
          if (method === "eth_accounts") return [];
          if (method === "eth_requestAccounts") return [account];
          return "0x1";
        },
      },
      account,
      network.chainId,
    ),
    /네트워크가 다릅니다/,
  );
});

test("unsupported passive account query uses authorization but transport failures are not retried as permission requests", async () => {
  for (const code of [4200, -32601]) {
    await assertWalletSession(
      {
        request: async ({ method }) => {
          if (method === "eth_accounts")
            throw Object.assign(new Error("Unsupported method"), { code });
          if (method === "eth_requestAccounts") return [account];
          return "0x7a69";
        },
      },
      account,
      network.chainId,
    );
  }
  const calls: string[] = [];
  await assert.rejects(
    assertWalletSession(
      {
        request: async ({ method }) => {
          calls.push(method);
          throw new Error("Transport failure");
        },
      },
      account,
      network.chainId,
    ),
    /Transport failure/,
  );
  assert.deepEqual(calls, ["eth_accounts"]);
});

test("connecting on the selected chain preserves the wallet session without a redundant chain switch", async () => {
  const connected = wallet();
  assert.equal(
    await connectInjectedWallet(connected.provider, network),
    account,
  );
  assert.equal(
    connected.calls.some(
      (call) => call.method === "wallet_switchEthereumChain",
    ),
    false,
  );
  const elsewhere = wallet("0x1");
  assert.equal(
    await connectInjectedWallet(elsewhere.provider, network),
    account,
  );
  assert.equal(
    elsewhere.calls.filter(
      (call) => call.method === "wallet_switchEthereumChain",
    ).length,
    1,
  );
});

test("connection reset revokes only this site's account permission and never signs or requests accounts", async () => {
  const calls: unknown[] = [];
  assert.equal(
    await revokeWalletConnection({
      request: async (args) => {
        calls.push(args);
        return null;
      },
    }),
    true,
  );
  assert.deepEqual(calls, [
    { method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] },
  ]);
  assert.equal(
    await revokeWalletConnection({
      request: async () => {
        throw Object.assign(new Error("Unsupported"), { code: 4200 });
      },
    }),
    false,
  );
  assert.equal(
    await revokeWalletConnection({
      request: async () => {
        throw Object.assign(new Error("Rejected"), { code: 4001 });
      },
    }),
    false,
  );
  assert.equal(
    await revokeWalletConnection({ request: async () => undefined }),
    false,
  );
});

test("a wallet that never answers reset does not keep the application blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = revokeWalletConnection({
    request: () => new Promise(() => {}),
  });
  t.mock.timers.tick(5001);
  assert.equal(await pending, false);
});

const third = "0x0000000000000000000000000000000000000003";
function multiAccount(
  authorized: string[],
  permissions: (params: unknown) => Promise<unknown> = async () => [
    { parentCapability: "eth_accounts" },
  ],
) {
  const calls: string[] = [];
  const provider: WalletProvider = {
    async request({ method, params }) {
      calls.push(method);
      if (method === "wallet_requestPermissions") return permissions(params);
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return authorized;
      if (method === "eth_chainId") return "0x7a69";
      return null;
    },
  };
  return { provider, calls };
}

test("account reselection asks the wallet to pick an account before reading it", async () => {
  const { provider, calls } = multiAccount([other]);
  assert.equal(
    await connectInjectedWallet(provider, network, { reselect: true }),
    other,
  );
  assert.deepEqual(calls.slice(0, 2), [
    "wallet_requestPermissions",
    "eth_requestAccounts",
  ]);
  // Without the option the established single-request flow is unchanged.
  const plain = multiAccount([account]);
  await connectInjectedWallet(plain.provider, network);
  assert.equal(plain.calls.includes("wallet_requestPermissions"), false);
});

test("wallets without permission requests fall back to account authorization, but a rejected pick stops", async () => {
  for (const failure of [
    { code: 4200 },
    { code: -32601 },
    { message: "Ronin: method not found" },
  ]) {
    const { provider } = multiAccount([account], async () => {
      throw Object.assign(new Error("unsupported"), failure);
    });
    assert.equal(
      await connectInjectedWallet(provider, network, { reselect: true }),
      account,
    );
  }
  for (const code of [4001, -32002]) {
    const { provider, calls } = multiAccount([account], async () => {
      throw Object.assign(new Error("rejected"), { code });
    });
    await assert.rejects(
      connectInjectedWallet(provider, network, { reselect: true }),
      /rejected/,
    );
    assert.equal(calls.includes("eth_requestAccounts"), false);
  }
});

test("several authorized accounts go to the chooser and the chosen one passes the signing check", async () => {
  const { provider } = multiAccount([account, other]);
  let offered: string[] = [];
  const chosen = await connectInjectedWallet(provider, network, {
    chooseAccount: async (accounts) => {
      offered = accounts;
      return accounts[1];
    },
  });
  assert.deepEqual(offered, [account, other]);
  assert.equal(chosen, other);
  await assertWalletSession(provider, other, network.chainId);
  await assert.rejects(
    assertWalletSession(provider, third, network.chainId),
    /계정이 변경/,
  );
  await assert.rejects(
    connectInjectedWallet(provider, network, {
      chooseAccount: async () => third,
    }),
    /계정을 선택/,
  );
  // A single account never prompts the chooser.
  const single = multiAccount([account]);
  assert.equal(
    await connectInjectedWallet(single.provider, network, {
      chooseAccount: async () => assert.fail("chooser must not open"),
    }),
    account,
  );
});
