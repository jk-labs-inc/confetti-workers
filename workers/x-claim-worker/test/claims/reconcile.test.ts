import {
  abortAllDurableObjects,
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseEther, parseGwei, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { coordinatorStub } from "../../src/claims/claimCoordinator";
import { NONCE_CONSUMED_GRACE_MS, PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS, STUCK_TX_REPLACE_AFTER_MS } from "../../src/claims/reconcile";
import worker from "../../src/index";
import {
  ageLedger,
  claimFor,
  ledgerAttempts,
  ledgerRows,
  PAYOUT_ADDRESS,
  runMaintenance,
  seedLink,
  useClaimNetwork,
  writeCrashedReservation,
} from "../support/claimNetwork";
import { captureErrorLogs } from "../support/harness";
import { randomAddress } from "../support/proofs";

const fakes = useClaimNetwork();

const claimRow = (id: string) => fakes.postgrest.rows("claims_history").find((row) => row.id === id);

const pendingClaim = async () => {
  const link = seedLink(fakes.postgrest);
  const outcome = await claimFor(link);
  if (outcome.outcome !== "pending") throw new Error(`expected pending, got ${outcome.outcome}`);
  return { link, claimId: outcome.claimId, txHash: outcome.txHash };
};

describe("reconcile", () => {
  it("records a payout that mined after the claim returned pending", async () => {
    fakes.chain.autoMine = false;
    const { claimId, txHash } = await pendingClaim();
    fakes.chain.mine();

    const report = await runMaintenance();

    expect(report).toMatchObject({ confirmed: 1, failed: 0 });
    expect(claimRow(claimId)).toMatchObject({ status: "paid", tx_hash: txHash });
  });

  it("records a payout whose result could not be written when the worker paid", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.failNext("PATCH", "claims_history");
    await claimFor(link);
    expect(fakes.postgrest.rows("claims_history")[0]?.status).toBe("pending");

    const report = await runMaintenance();

    expect(report.recorded).toBe(1);
    expect(fakes.postgrest.rows("claims_history")[0]?.status).toBe("paid");
    expect(await ledgerRows()).toEqual([expect.objectContaining({ state: "confirmed", recorded: 1 })]);
  });

  it("rebroadcasts a payout the node never received and pays it exactly once", async () => {
    fakes.chain.failNextSend({ kind: "http" });
    const link = seedLink(fakes.postgrest);
    const outcome = await claimFor(link);
    expect(outcome.outcome).toBe("pending");
    expect(fakes.chain.accepted).toHaveLength(0);

    expect(await runMaintenance()).toMatchObject({ rebroadcast: 1 });
    expect(await runMaintenance()).toMatchObject({ confirmed: 1 });

    expect(fakes.chain.mined).toHaveLength(1);
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
    expect(fakes.postgrest.rows("claims_history")[0]?.status).toBe("paid");
  });

  it("abandons a signed payout whose claim row was never written, freeing its nonce", async () => {
    const claimId = crypto.randomUUID();
    await writeCrashedReservation(claimId, randomAddress().toLowerCase() as Hex, 0);

    expect(await runMaintenance()).toMatchObject({ abandoned: 1 });
    expect(fakes.chain.accepted).toHaveLength(0);

    expect((await claimFor(seedLink(fakes.postgrest))).outcome).toBe("paid");
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0]);
  });

  it("fails a pending row that was written after its crashed reservation was abandoned", async () => {
    const claimId = crypto.randomUUID();
    const recipient = randomAddress().toLowerCase() as Hex;
    await writeCrashedReservation(claimId, recipient, 0);
    expect(await runMaintenance()).toMatchObject({ abandoned: 1 });
    const lateRow = fakes.postgrest.seed("claims_history", {
      id: claimId,
      address: recipient,
      platform_user_id: "late",
      status: "pending",
      created_at: new Date(Date.now() - PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS - 1000).toISOString(),
    });

    expect(await runMaintenance()).toMatchObject({ expiredPending: 1 });
    expect(lateRow.status).toBe("failed");
  });

  it("replaces a stuck payout at the same nonce with higher fees and pays once", async () => {
    fakes.chain.autoMine = false;
    const { link, claimId, txHash } = await pendingClaim();
    await ageLedger(claimId, STUCK_TX_REPLACE_AFTER_MS + 1000);
    fakes.chain.priorityFeePerGas += parseGwei("5");

    expect(await runMaintenance()).toMatchObject({ replaced: 1 });

    const [replacement, ...others] = fakes.chain.pendingTransactions();
    expect(others).toHaveLength(0);
    expect(replacement?.hash).not.toBe(txHash);
    expect(replacement?.nonce).toBe(0);
    expect(replacement!.maxFeePerGas).toBeGreaterThan(fakes.chain.accepted[0]!.maxFeePerGas);

    fakes.chain.mine();
    expect(await runMaintenance()).toMatchObject({ confirmed: 1 });
    expect(claimRow(claimId)).toMatchObject({ status: "paid", tx_hash: replacement?.hash });
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
  });

  it("rebroadcasts a stuck payout without raising fees while it still pays the market rate", async () => {
    fakes.chain.autoMine = false;
    const { claimId, txHash } = await pendingClaim();
    fakes.chain.dropPending();
    await ageLedger(claimId, STUCK_TX_REPLACE_AFTER_MS + 1000);

    expect(await runMaintenance()).toMatchObject({ replaced: 0, rebroadcast: 1 });
    expect(fakes.chain.pendingTransactions().map((tx) => tx.hash)).toEqual([txHash]);
    expect(await ledgerAttempts()).toHaveLength(1);
  });

  it("does not stack fee bumps on replacements the node rejected", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();
    fakes.chain.priorityFeePerGas += parseGwei("5");
    await ageLedger(claimId, STUCK_TX_REPLACE_AFTER_MS + 1000);
    fakes.chain.failNextSend({ kind: "rpc", message: "insufficient funds for gas * price + value" });
    expect(await runMaintenance()).toMatchObject({ replaced: 1 });

    for (let run = 0; run < 3; run += 1) {
      await ageLedger(claimId, STUCK_TX_REPLACE_AFTER_MS + 1000);
      expect(await runMaintenance()).toMatchObject({ replaced: 0 });
    }

    const attempts = await ledgerAttempts();
    expect(attempts).toHaveLength(2);
    const [pending] = fakes.chain.pendingTransactions();
    expect(pending?.hash).toBe(attempts[1]?.hash);
  });

  it("keeps reconciling the other payouts when one lookup fails", async () => {
    fakes.chain.autoMine = false;
    const first = await pendingClaim();
    const second = await pendingClaim();
    fakes.chain.mine();
    fakes.chain.failReceiptLookupsFor(first.txHash as Hex);

    expect(await runMaintenance()).toMatchObject({ confirmed: 1, failedSteps: 1 });
    expect(claimRow(first.claimId)?.status).toBe("pending");
    expect(claimRow(second.claimId)?.status).toBe("paid");
  });

  it("fails a payout whose nonce was used by another transaction", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();
    fakes.chain.dropPending();
    fakes.chain.consumeNonceElsewhere(PAYOUT_ADDRESS);
    expect(await runMaintenance()).toMatchObject({ failed: 0 });
    await ageLedger(claimId, NONCE_CONSUMED_GRACE_MS + 1000);

    expect(await runMaintenance()).toMatchObject({ failed: 1 });
    expect(claimRow(claimId)?.status).toBe("failed");
  });

  it("counts the grace period from when the nonce was first seen used, not from the payout's age", async () => {
    fakes.chain.autoMine = false;
    const { claimId, txHash } = await pendingClaim();
    await ageLedger(claimId, NONCE_CONSUMED_GRACE_MS + 1000);
    fakes.chain.mine();
    fakes.chain.withholdReceipt(txHash as Hex);

    expect(await runMaintenance()).toMatchObject({ confirmed: 0, failed: 0 });
    fakes.chain.releaseReceipts();

    expect(await runMaintenance()).toMatchObject({ confirmed: 1, failed: 0 });
    expect(claimRow(claimId)).toMatchObject({ status: "paid", tx_hash: txHash });
  });

  it("waits out the grace period before deciding a nonce was used elsewhere", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();
    fakes.chain.consumeNonceElsewhere(PAYOUT_ADDRESS);

    expect(await runMaintenance()).toMatchObject({ failed: 0 });
    expect(claimRow(claimId)?.status).toBe("pending");
  });

  it("expires an old pending row that has no payout behind it", async () => {
    const row = fakes.postgrest.seed("claims_history", {
      address: randomAddress().toLowerCase(),
      platform_user_id: "orphan",
      status: "pending",
      created_at: new Date(Date.now() - PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS - 1000).toISOString(),
    });

    expect(await runMaintenance()).toMatchObject({ expiredPending: 1 });
    expect(row.status).toBe("failed");
  });

  it("marks an old pending row paid when its transaction did mine", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();
    fakes.chain.mine();
    const orphan = claimRow(claimId)!;
    await runInDurableObject(coordinatorStub(env), (_, state) => state.storage.deleteAll());
    await abortAllDurableObjects();
    orphan.created_at = new Date(Date.now() - PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS - 1000).toISOString();

    expect(await runMaintenance()).toMatchObject({ expiredPending: 1 });
    expect(orphan.status).toBe("paid");
  });

  it("leaves recent pending rows alone", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();

    expect(await runMaintenance()).toMatchObject({ expiredPending: 0, failed: 0 });
    expect(claimRow(claimId)?.status).toBe("pending");
  });
});

describe("low-balance alert", () => {
  const alertsIn = (logs: string[]) => logs.filter((line) => line.startsWith("ALERT: "));

  it("logs an alert when the payout wallet is worth less than the threshold", async () => {
    const logs = captureErrorLogs();
    fakes.alchemy.usdPrice = "0.05";

    const report = await runMaintenance();

    expect(report.lowBalanceAlerted).toBe(true);
    expect(alertsIn(logs)).toEqual([expect.stringContaining("holds 1000 POL (about $50.00), below the $100 alert level")]);
  });

  it("alerts at most once per interval", async () => {
    const logs = captureErrorLogs();
    fakes.alchemy.usdPrice = "0.05";

    await runMaintenance();
    const second = await runMaintenance();

    expect(second.lowBalanceAlerted).toBe(false);
    expect(alertsIn(logs)).toHaveLength(1);
  });

  it("still checks the balance when a reconcile step fails", async () => {
    const logs = captureErrorLogs();
    fakes.alchemy.usdPrice = "0.05";
    fakes.postgrest.failNext("GET", "claims_history");

    expect(await runMaintenance()).toMatchObject({
      failedSteps: 1,
      lowBalanceAlerted: true,
    });
    expect(alertsIn(logs)).toHaveLength(1);
  });

  it("skips the check rather than failing the run when the price is not a plain decimal", async () => {
    const logs = captureErrorLogs();
    fakes.alchemy.usdPrice = "1.2e-1";

    expect((await runMaintenance()).lowBalanceAlerted).toBe(false);
    expect(alertsIn(logs)).toHaveLength(0);
  });

  it("stays quiet while the wallet holds enough", async () => {
    const logs = captureErrorLogs();

    expect((await runMaintenance()).lowBalanceAlerted).toBe(false);
    expect(alertsIn(logs)).toHaveLength(0);
  });
});

describe("scheduled handler", () => {
  it("runs maintenance on the cron trigger", async () => {
    fakes.chain.autoMine = false;
    const { claimId } = await pendingClaim();
    fakes.chain.mine();
    const ctx = createExecutionContext();

    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(claimRow(claimId)?.status).toBe("paid");
  });
});
