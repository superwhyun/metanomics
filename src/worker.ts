import { parseTransaction, type Hex } from "viem";
import { Store } from "./db.js";
import { EvmAdapter, NATIVE_TRANSFER_GAS } from "./chain.js";
import { id, json, chainIdOf, type Operation } from "./shared.js";

const terminal = new Set(["FINALIZED", "FAILED"]);
// Keeps the relayer able to pay gas by moving RON from the admin wallet.
export interface RelayerFunding {
  minWei: bigint;
  topupWei: bigint;
  adminMinWei: bigint;
  intervalMs: number;
}
const ISSUANCE_STEPS = new Set(["mint", "approve", "fundReserve"]);
const ISSUANCE_NEXT: Record<string, string> = {
  mint: "approve",
  approve: "fundReserve",
};
export class Worker {
  busy = false;
  lastError: string | null = null;
  // Fault hooks are injected by tests; no public fault injection endpoint exists.
  afterPersist?: (operation: Operation) => void;
  afterBroadcast?: (operation: Operation) => void;
  fundingWarning: string | null = null;
  private fundingCheckedAt = 0;
  constructor(
    public store: Store,
    public adapters: Map<string, EvmAdapter>,
    public funding?: RelayerFunding,
  ) {}
  adapter(deployment: string) {
    const a = this.adapters.get(deployment);
    if (!a) throw new Error(`Missing immutable deployment ${deployment}`);
    return a;
  }
  queue(
    kind: string,
    resourceId: string,
    gameId: string | null,
    deployment: string,
    signer: "relayer" | "admin",
    args: any[],
    reservation = "0",
  ) {
    const prior = this.store.get(
      "SELECT * FROM operations WHERE kind=? AND resource_id=?",
      kind,
      resourceId,
    );
    if (prior) {
      if (kind === "resolve" && prior.status === "FAILED")
        this.store.run(
          "UPDATE operations SET status='QUEUED',payload=?,error=NULL WHERE id=?",
          json(args),
          prior.id,
        );
      return prior.id;
    }
    const operationId = id("operation");
    this.store.run(
      "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      operationId,
      kind,
      resourceId,
      gameId,
      deployment,
      signer,
      "QUEUED",
      json(args),
      reservation,
      null,
      Date.now(),
    );
    return operationId;
  }
  reserved(deployment: string, gameId: string): bigint {
    return this.store
      .all(
        "SELECT reservation FROM operations WHERE deployment_id=? AND game_id=? AND kind!='allocate'",
        deployment,
        gameId,
      )
      .reduce((sum, row) => sum + BigInt(row.reservation), 0n);
  }
  // Allocations already in a block but newer than the finalized snapshot: the
  // budget can use them right away instead of waiting ~24 min for finality.
  incoming(deployment: string, gameId: string, snapshotBlock: string): bigint {
    return this.store
      .all(
        "SELECT o.reservation FROM operations o JOIN transaction_attempts t ON t.operation_id=o.id AND t.status='INCLUDED' WHERE o.deployment_id=? AND o.game_id=? AND o.kind='allocate' AND o.status='INCLUDED' AND CAST(t.block_number AS INTEGER) > CAST(? AS INTEGER)",
        deployment,
        gameId,
        snapshotBlock,
      )
      .reduce((sum, row) => sum - BigInt(row.reservation), 0n);
  }
  // A successful allocation in a block is recorded as a negative reservation
  // (incoming budget); a reorg clears it until the replay lands again.
  markAllocation(op: Operation, included: boolean) {
    if (op.kind !== "allocate") return;
    this.store.run(
      "UPDATE operations SET reservation=? WHERE id=? AND status NOT IN ('FINALIZED','FAILED')",
      included ? (-BigInt(JSON.parse(op.payload)[2])).toString() : "0",
      op.id,
    );
  }
  async refreshBudget(deployment: string, gameId: string, block?: any) {
    const a = this.adapter(deployment);
    block ??= await a.finalBlock();
    const old = this.store.get(
      "SELECT * FROM budget_snapshots WHERE deployment_id=? AND game_id=?",
      deployment,
      gameId,
    );
    let discrepancy: any;
    if (old && BigInt(old.block_number) <= block.number) {
      const expected = await a.getGameBudget(gameId, BigInt(old.block_number));
      if (expected !== BigInt(old.amount))
        discrepancy = {
          deploymentId: deployment,
          gameId,
          blockNumber: old.block_number,
          cached: old.amount,
          onchain: expected.toString(),
        };
    }
    const balance = await a.getGameBudget(gameId, block.number);
    this.store.transaction(() => {
      if (discrepancy) {
        this.store.audit("system", "budget.reconciled", discrepancy);
        this.store.event(gameId, "budget.reconciled", gameId, discrepancy);
      }
      this.snapshot(deployment, gameId, block, balance);
    });
    return this.store.get(
      "SELECT * FROM budget_snapshots WHERE deployment_id=? AND game_id=?",
      deployment,
      gameId,
    );
  }
  snapshot(deployment: string, gameId: string, block: any, balance: bigint) {
    const old = this.store.get(
      "SELECT * FROM budget_snapshots WHERE deployment_id=? AND game_id=?",
      deployment,
      gameId,
    );
    if (!old || BigInt(old.block_number) <= block.number)
      this.store.run(
        "INSERT INTO budget_snapshots VALUES(?,?,?,?,?) ON CONFLICT(deployment_id,game_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,amount=excluded.amount",
        deployment,
        gameId,
        block.number.toString(),
        block.hash,
        balance.toString(),
      );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    let tickError: string | null = null;
    try {
      for (const a of this.adapters.values()) {
        try {
          await this.sync(a);
        } catch (e: any) {
          tickError = `Event sync ${a.deployment.id}: ${e.message}`;
        }
      }
      const ops = this.store.all(
        "SELECT * FROM operations WHERE status NOT IN ('FINALIZED','FAILED') ORDER BY created_at,rowid",
      ) as Operation[];
      const blocked = new Set<string>();
      for (const op of ops) {
        const a = this.adapter(op.deployment_id);
        const signer = a.wallets[op.signer]?.account.address;
        const key = `${a.deployment.chainId}:${signer}`;
        if (blocked.has(key)) continue;
        try {
          await this.process(op, a);
        } catch (e: any) {
          tickError = e.message;
          const current = this.store.get(
            "SELECT status FROM operations WHERE id=?",
            op.id,
          );
          if (!terminal.has(current.status))
            this.store.run(
              "UPDATE operations SET status=?,error=? WHERE id=?",
              "RECONCILING",
              e.message.slice(0, 1000),
              op.id,
            );
        }
        const current = this.store.get(
          "SELECT status FROM operations WHERE id=?",
          op.id,
        );
        // A signer's next transaction waits until the previous one is in a block,
        // not until it is final: finality can lag tens of minutes on Saigon.
        // Business results are still applied only at finality, and a reorg that
        // drops an included transaction replays the same signed bytes in order.
        if (!terminal.has(current.status) && current.status !== "INCLUDED")
          blocked.add(key);
      }
      for (const a of this.adapters.values()) {
        try {
          await this.sync(a);
        } catch (e: any) {
          tickError = `Event sync ${a.deployment.id}: ${e.message}`;
        }
      }
      try {
        await this.autoFundRelayers();
      } catch (e: any) {
        tickError = `Relayer funding: ${e.message}`;
      }
      this.lastError = tickError;
    } catch (e: any) {
      this.lastError = e.message;
    } finally {
      this.busy = false;
    }
  }
  async process(op: Operation, a: EvmAdapter) {
    const final = await a.finalBlock();
    let attempt = this.store.get(
      "SELECT * FROM transaction_attempts WHERE operation_id=? AND status!='FAILED' ORDER BY rowid DESC LIMIT 1",
      op.id,
    );
    if (!attempt) {
      // Admin/relayer transactions for the same wallet are serialized across deployments.
      if (!a.wallets[op.signer])
        throw new Error(`${op.signer} signer unavailable`);
      const nonce = await a.publicClient.getTransactionCount({
        address: a.wallets[op.signer].account.address,
        blockTag: "pending",
      });
      let tx;
      try {
        tx = await a.buildTransaction(
          op.kind,
          JSON.parse(op.payload),
          op.signer,
          nonce,
        );
      } catch (error: any) {
        // Only an actual contract revert is terminal before signing. RPC/gas errors are retried.
        if (
          error.walk?.(
            (cause: any) =>
              cause?.name === "ContractFunctionRevertedError" ||
              cause?.name === "ExecutionRevertedError",
          ) ||
          /execution reverted|reverted with/i.test(error.message)
        ) {
          await this.finish(
            op,
            a,
            final,
            false,
            error.shortMessage ?? error.message,
          );
          return;
        }
        throw error;
      }
      this.store.transaction(() => {
        this.store.run(
          "INSERT INTO transaction_attempts VALUES(?,?,?,?,?,?,?,?,?)",
          id("attempt"),
          op.id,
          tx.hash,
          tx.raw,
          tx.nonce,
          "PREPARED",
          null,
          null,
          Date.now(),
        );
        this.store.run(
          "UPDATE operations SET status=?,error=NULL WHERE id=?",
          "PREPARED",
          op.id,
        );
      });
      this.afterPersist?.(op);
      attempt = this.store.get(
        "SELECT * FROM transaction_attempts WHERE hash=?",
        tx.hash,
      );
    }
    let receipt = await a.getTransactionStatus(attempt.hash);
    if (!receipt) {
      // A superseded transaction may win the replacement race. Inspect every hash.
      for (const old of this.store.all(
        "SELECT hash FROM transaction_attempts WHERE operation_id=? AND hash!=? ORDER BY rowid DESC",
        op.id,
        attempt.hash,
      )) {
        receipt = await a.getTransactionStatus(old.hash);
        if (receipt) break;
      }
    }
    if (!receipt) {
      // A receipt can disappear during a reorg; clear the previous inclusion and reuse the raw tx.
      this.store.run(
        "UPDATE transaction_attempts SET status=?,block_number=NULL,block_hash=NULL WHERE id=?",
        "SUBMITTED",
        attempt.id,
      );
      this.publishRegistration(op, false);
      this.markAllocation(op, false);
      try {
        await a.broadcastTransaction(attempt.raw);
      } catch (e: any) {
        if (!/already known|known transaction/i.test(e.message)) {
          const recovered = await a.reconcileOperation(
            op.kind,
            op.resource_id,
            final.number,
          );
          if (recovered) {
            await this.finish(op, a, final, true);
            return;
          }
          throw e;
        }
      }
      this.afterBroadcast?.(op);
      this.store.run(
        "UPDATE operations SET status=?,error=NULL WHERE id=?",
        "SUBMITTED",
        op.id,
      );
      receipt = await a.getTransactionStatus(attempt.hash);
    }
    if (!receipt) return;
    this.store.run(
      "UPDATE transaction_attempts SET status=?,block_number=?,block_hash=? WHERE id=?",
      "INCLUDED",
      receipt.blockNumber.toString(),
      receipt.blockHash,
      this.store.get(
        "SELECT id FROM transaction_attempts WHERE hash=?",
        receipt.transactionHash,
      )?.id ?? attempt.id,
    );
    this.store.run(
      "UPDATE operations SET status=? WHERE id=?",
      "INCLUDED",
      op.id,
    );
    if (receipt.status === "success") {
      this.publishRegistration(op, true);
      this.markAllocation(op, true);
    }
    const finalized = await a.finalBlock();
    if (receipt.blockNumber > finalized.number) return;
    const canonical = await a.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash) {
      this.store.run(
        "UPDATE operations SET status=? WHERE id=?",
        "RECONCILING",
        op.id,
      );
      this.publishRegistration(op, false);
      this.markAllocation(op, false);
      return;
    }
    const success =
      receipt.status === "success" ||
      (await a.reconcileOperation(op.kind, op.resource_id, finalized.number));
    await this.finish(
      op,
      a,
      finalized,
      success,
      success ? undefined : "Contract transaction reverted",
      receipt.transactionHash,
      receipt.status === "success",
    );
  }
  async finish(
    op: Operation,
    a: EvmAdapter,
    block: any,
    success: boolean,
    error?: string,
    winningHash?: string,
    winningSucceeded = success,
  ) {
    const budget = op.game_id
      ? await a.getGameBudget(op.game_id, block.number)
      : null;
    const payment = [
      "pay",
      "claimDelivery",
      "fulfill",
      "refund",
      "resolve",
    ].includes(op.kind)
      ? await a.read("payments", [chainIdOf(op.resource_id)], block.number)
      : null;
    this.store.transaction(() => {
      const before = this.store.get(
        "SELECT status FROM operations WHERE id=?",
        op.id,
      );
      if (terminal.has(before.status)) return;
      this.store.run(
        "UPDATE operations SET status=?,reservation=?,error=? WHERE id=?",
        success ? "FINALIZED" : "FAILED",
        "0",
        error?.slice(0, 1000) ?? null,
        op.id,
      );
      this.store.run(
        "UPDATE transaction_attempts SET status=? WHERE operation_id=? AND status!='FAILED'",
        winningHash ? "SUPERSEDED" : success ? "RECONCILED" : "FAILED",
        op.id,
      );
      if (winningHash)
        this.store.run(
          "UPDATE transaction_attempts SET status=? WHERE hash=?",
          winningSucceeded ? "FINALIZED" : "FAILED",
          winningHash,
        );
      if (op.game_id && budget !== null)
        this.snapshot(op.deployment_id, op.game_id, block, budget);
      if (payment && Number(payment[5]) > 0)
        this.applyPayment(op.resource_id, payment);
      else if (op.kind === "pay" && !success)
        this.store.run(
          "UPDATE payments SET status='CREATED' WHERE id=? AND status='PROCESSING'",
          op.resource_id,
        );
      if (op.kind === "budgetAction")
        this.store.run(
          "UPDATE budget_actions SET status=? WHERE id=?",
          success ? "FINALIZED" : "FAILED",
          op.resource_id,
        );
      if (ISSUANCE_STEPS.has(op.kind)) this.advanceIssuance(op, success, error);
      if (op.kind === "registerGame") {
        this.store.run(
          "UPDATE game_registrations SET status=? WHERE operation_id=?",
          success ? "APPROVED" : "FAILED",
          op.id,
        );
        const args = JSON.parse(op.payload);
        // A recorded on-chain resume leaves the portal switch alone; every other
        // registration result (approval, stop) is mirrored into the portal.
        if (success && !(op.resource_id.startsWith("chain-state-") && args[2]))
          this.store.run(
            "UPDATE games SET active=? WHERE id=?",
            args[2] ? 1 : 0,
            op.game_id,
          );
        // An approval published on inclusion is withdrawn if it finally failed.
        if (
          !success &&
          this.store.get(
            "SELECT 1 FROM game_registrations WHERE operation_id=?",
            op.id,
          )
        )
          this.store.run("UPDATE games SET active=0 WHERE id=?", op.game_id);
      }
      this.store.event(
        op.game_id,
        success ? `${op.kind}.finalized` : `${op.kind}.failed`,
        op.resource_id,
        { operationId: op.id, error: error ?? null },
        `operation:${op.id}:${success}`,
      );
    });
  }
  // Game approvals are published as soon as the registration is in a block:
  // listing a game moves no money, and Saigon finality can lag tens of minutes.
  // A reorg withdraws the listing until the same signed transaction is back in.
  publishRegistration(op: Operation, included: boolean) {
    if (op.kind !== "registerGame") return;
    const registration = this.store.get(
      "SELECT id FROM game_registrations WHERE operation_id=?",
      op.id,
    );
    if (!registration || !JSON.parse(op.payload)[2]) return;
    this.store.transaction(() => {
      this.store.run(
        "UPDATE game_registrations SET status=? WHERE id=? AND status=?",
        included ? "APPROVED" : "REGISTERING",
        registration.id,
        included ? "REGISTERING" : "APPROVED",
      );
      this.store.run(
        "UPDATE games SET active=? WHERE id=?",
        included ? 1 : 0,
        op.game_id,
      );
    });
  }
  async autoFundRelayers() {
    const funding = this.funding;
    if (!funding || Date.now() - this.fundingCheckedAt < funding.intervalMs)
      return;
    this.fundingCheckedAt = Date.now();
    for (const a of this.adapters.values()) {
      if (!a.wallets.admin) continue;
      // One transfer at a time; the balance only moves once it is included.
      if (
        this.store.get(
          "SELECT 1 FROM operations WHERE kind='fundRelayer' AND deployment_id=? AND status NOT IN ('FINALIZED','FAILED')",
          a.deployment.id,
        )
      )
        continue;
      const [relayer, admin, gasPrice] = await Promise.all([
        a.publicClient.getBalance({ address: a.deployment.relayer }),
        a.publicClient.getBalance({ address: a.deployment.admin }),
        a.publicClient.getGasPrice(),
      ]);
      if (relayer >= funding.minWei) {
        this.fundingWarning = null;
        continue;
      }
      const available =
        admin - funding.adminMinWei - gasPrice * NATIVE_TRANSFER_GAS;
      const amount =
        available < funding.topupWei ? available : funding.topupWei;
      if (amount <= 0n) {
        this.fundingWarning =
          "중계 지갑 잔액이 부족하지만 관리자 지갑이 최소 유지분밖에 없어 자동 충전하지 못했습니다. 관리자 지갑을 충전하세요.";
        continue;
      }
      this.store.transaction(() => {
        const operationId = this.queue(
          "fundRelayer",
          id("funding-auto"),
          null,
          a.deployment.id,
          "admin",
          [amount.toString()],
        );
        this.store.audit("system", "relayer.fund", {
          trigger: "auto",
          amountWei: amount.toString(),
          operationId,
        });
      });
      this.fundingWarning =
        amount < funding.topupWei
          ? "관리자 지갑 잔액이 적어 설정한 양보다 적게 자동 충전했습니다. 관리자 지갑을 충전하세요."
          : null;
    }
  }
  // Reserve issuance is mint → approve → fundReserve. A step is queued only after the
  // previous one is final, so a failed mint never leaves an approval or funding behind.
  advanceIssuance(op: Operation, success: boolean, error?: string) {
    const issuance = this.store.get(
      "SELECT * FROM issuances WHERE id=?",
      op.resource_id,
    );
    if (!issuance) return;
    const next =
      success && issuance.target === "reserve"
        ? ISSUANCE_NEXT[op.kind]
        : undefined;
    if (next) {
      const a = this.adapter(issuance.deployment_id);
      this.queue(
        next,
        issuance.id,
        null,
        issuance.deployment_id,
        "admin",
        next === "approve"
          ? [a.deployment.settlement, issuance.amount]
          : [issuance.amount],
      );
      this.store.run(
        "UPDATE issuances SET status=? WHERE id=?",
        next === "approve" ? "APPROVING" : "FUNDING",
        issuance.id,
      );
      return;
    }
    this.store.run(
      "UPDATE issuances SET status=?,error=? WHERE id=?",
      success ? "COMPLETED" : "FAILED",
      error ? `${op.kind}: ${error}`.slice(0, 1000) : null,
      issuance.id,
    );
  }
  applyPayment(paymentId: string, p: any) {
    const status = [
      "CREATED",
      "PAID",
      "DELIVERY_CLAIMED",
      "COMPLETED",
      "REFUNDED",
    ][Number(p[5])];
    this.store.run(
      "UPDATE payments SET status=?,claim_by=? WHERE id=?",
      status,
      Number(p[4]),
      paymentId,
    );
  }
  async sync(a: EvmAdapter) {
    const block = await a.finalBlock();
    await this.reconcilePayments(a, block);
    const cursorId = `chain:${a.deployment.id}`;
    const old = this.store.get(
      "SELECT value FROM processing_cursors WHERE id=?",
      cursorId,
    );
    const from = old ? BigInt(old.value) + 1n : BigInt(a.deployment.fromBlock);
    const end = from + BigInt(a.capabilities().maxLogBlockRange - 1);
    const to = end < block.number ? end : block.number;
    if (from <= to) {
      const events = await a.readEvents(from, to);
      const observed = block;
      const gameBudgets = await Promise.all(
        this.store
          .all("SELECT id FROM games")
          .map(
            async (g) =>
              [g.id, await a.getGameBudget(g.id, block.number)] as const,
          ),
      );
      this.store.transaction(() => {
        for (const event of events) {
          const eventId = `${a.deployment.id}:${event.blockHash}:${event.transactionHash}:${event.logIndex}`;
          this.store.run(
            "INSERT OR IGNORE INTO chain_events VALUES(?,?,?,?,?)",
            eventId,
            a.deployment.id,
            event.blockNumber.toString(),
            event.blockHash,
            json(event),
          );
          const game = this.store
            .all("SELECT id FROM games")
            .find((g) => chainIdOf(g.id) === event.args.gameId);
          // The event cursor can lag behind current projections. Do not regress a
          // completed payment by replaying an older PAID event; current state was reconciled above.
          this.store.event(
            game?.id ?? null,
            `chain.${event.eventName}`,
            event.args.paymentId ??
              event.args.rewardId ??
              event.args.allocationId ??
              eventId,
            {
              ...event.args,
              deploymentId: a.deployment.id,
              blockNumber: event.blockNumber.toString(),
            },
            eventId,
          );
        }
        // Snapshot update and release of finalized reservations happen together in finish().
        // Never advance budget here while matching operations are still reserved.
        if (
          !this.store.get(
            "SELECT id FROM operations WHERE deployment_id=? AND reservation!='0' LIMIT 1",
            a.deployment.id,
          )
        ) {
          for (const [gameId, value] of gameBudgets)
            this.snapshot(a.deployment.id, gameId, observed, value);
        }
        this.store.run(
          "INSERT INTO processing_cursors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          cursorId,
          to.toString(),
        );
      });
    }
  }
  async reconcilePayments(a: EvmAdapter, block: any) {
    for (const p of this.store.all(
      "SELECT * FROM payments WHERE deployment_id=? AND status IN ('CREATED','PROCESSING','PAID','DELIVERY_CLAIMED')",
      a.deployment.id,
    )) {
      const onchain = await a.read("payments", [chainIdOf(p.id)], block.number);
      if (Number(onchain[5]) > 0)
        this.store.transaction(() => this.applyPayment(p.id, onchain));
      else if (
        BigInt(block.timestamp) > BigInt(p.expires_at) &&
        !this.store.get(
          "SELECT id FROM operations WHERE resource_id=? AND status NOT IN ('FINALIZED','FAILED')",
          p.id,
        )
      )
        this.store.run("UPDATE payments SET status='EXPIRED' WHERE id=?", p.id);
      if (
        Number(onchain[5]) === 1 &&
        BigInt(block.timestamp) > BigInt(onchain[4])
      ) {
        this.store.transaction(() =>
          this.queue("refund", p.id, p.game_id, p.deployment_id, "relayer", [
            chainIdOf(p.id),
          ]),
        );
      }
    }
  }
  async replace(operationId: string) {
    const op = this.store.get(
      "SELECT * FROM operations WHERE id=?",
      operationId,
    ) as Operation;
    if (!op || terminal.has(op.status))
      throw new Error("Operation is not pending");
    const a = this.adapter(op.deployment_id);
    const old = this.store.get(
      "SELECT * FROM transaction_attempts WHERE operation_id=? ORDER BY rowid DESC LIMIT 1",
      operationId,
    );
    if (!old || (await a.getTransactionStatus(old.hash)))
      throw new Error("Only a pending signed transaction can be replaced");
    const decoded: any = parseTransaction(old.raw);
    const fee = (decoded.gasPrice * 125n) / 100n + 1n;
    const tx = await a.buildTransaction(
      op.kind,
      JSON.parse(op.payload),
      op.signer,
      old.nonce,
      fee,
      decoded.gas,
    );
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO transaction_attempts VALUES(?,?,?,?,?,?,?,?,?)",
        id("attempt"),
        op.id,
        tx.hash,
        tx.raw,
        tx.nonce,
        "PREPARED",
        null,
        null,
        Date.now(),
      );
      this.store.run(
        "UPDATE operations SET status='PREPARED' WHERE id=?",
        op.id,
      );
    });
    return tx.hash;
  }
}
