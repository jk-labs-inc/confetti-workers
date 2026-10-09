import type { Hex } from "viem";
import {
  broadcast,
  bumpedFees,
  currentFees,
  isBelowMarket,
  receiptFor,
  signTransfer,
  transactionCount,
  type PayoutChain,
} from "../payout/chain";
import { loggableErrorText } from "../payout/errors";
import type { PayoutLedger } from "../payout/ledger";
import type { FeeQuote, LedgerAttempt, LedgerEntry } from "../payout/types";
import { stalePendingClaims, updateClaim } from "../supabase/claimsHistory";
import type { ClaimRow, SupabaseConfig } from "../supabase/types";
import { abandonIfUnreserved, recordPayoutResult, retryRecording, type FinalLedgerState } from "./payoutResults";
import type { ReconcileReport } from "./types";

export const STUCK_TX_REPLACE_AFTER_MS = 5 * 60_000;
export const NONCE_CONSUMED_GRACE_MS = 5 * 60_000;
export const PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS = 10 * 60_000;

interface ReconcileContext {
  ledger: PayoutLedger;
  chain: PayoutChain;
  config: SupabaseConfig;
  now: number;
  report: ReconcileReport;
}

const emptyReport = (): ReconcileReport => ({
  confirmed: 0,
  failed: 0,
  abandoned: 0,
  rebroadcast: 0,
  replaced: 0,
  recorded: 0,
  expiredPending: 0,
  failedSteps: 0,
});

const runStep = async (report: ReconcileReport, step: string, task: () => Promise<void>): Promise<void> => {
  try {
    await task();
  } catch (error) {
    console.error(`reconcile step failed: ${step}`, loggableErrorText(error));
    report.failedSteps += 1;
  }
};

const settle = async (
  { ledger, config, report }: ReconcileContext,
  entry: LedgerEntry,
  state: FinalLedgerState,
  confirmedHash: Hex | null = null,
): Promise<void> => {
  await recordPayoutResult(ledger, config, entry.claimId, state, confirmedHash);
  report[state] += 1;
};

const replaceStuckTransfer = async (
  context: ReconcileContext,
  entry: LedgerEntry,
  latest: LedgerAttempt,
  market: FeeQuote,
): Promise<void> => {
  const { ledger, chain, now, report } = context;
  const replacement = await signTransfer(
    chain,
    { recipient: entry.recipient, valueWei: entry.valueWei, nonce: entry.nonce },
    bumpedFees(latest.fees, market),
    latest.gas,
  );
  ledger.addAttempt(entry.claimId, replacement, now);
  if ((await broadcast(chain, replacement.rawTransaction)) === "sent") ledger.setState(entry.claimId, "sent", now);
  report.replaced += 1;
};

const reconcileOutstanding = async (
  context: ReconcileContext,
  entry: LedgerEntry,
  confirmedTransactionCount: number,
): Promise<void> => {
  const { ledger, chain, config, now, report } = context;
  const receipt = await receiptFor(chain, entry.attempts.map((attempt) => attempt.hash));
  if (receipt) return settle(context, entry, receipt.status === "success" ? "confirmed" : "failed", receipt.hash);

  if (confirmedTransactionCount > entry.nonce) {
    if (entry.nonceConsumedSeenAt === null) ledger.markNonceConsumedSeen(entry.claimId, now);
    else if (now - entry.nonceConsumedSeenAt >= NONCE_CONSUMED_GRACE_MS) return settle(context, entry, "failed");
  }

  if (await abandonIfUnreserved(ledger, config, entry)) {
    report.abandoned += 1;
    return;
  }

  const latest = entry.attempts[0];
  if (!latest) return;
  if (now - latest.createdAt >= STUCK_TX_REPLACE_AFTER_MS) {
    const market = await currentFees(chain);
    if (isBelowMarket(latest.fees, market)) return replaceStuckTransfer(context, entry, latest, market);
  }

  const result = await broadcast(chain, latest.rawTransaction);
  if (result === "sent" && entry.state === "signed") ledger.setState(entry.claimId, "sent", now);
  report.rebroadcast += 1;
};

const expireIfWithoutPayout = async (context: ReconcileContext, claim: ClaimRow): Promise<void> => {
  const { ledger, chain, config, report } = context;
  const entry = ledger.entry(claim.id);
  if (entry && entry.state !== "abandoned") return;
  const receipt = claim.tx_hash ? await receiptFor(chain, [claim.tx_hash as Hex]) : null;
  await updateClaim(config, claim.id, { status: receipt?.status === "success" ? "paid" : "failed" });
  report.expiredPending += 1;
};

const expirePendingWithoutPayout = async (context: ReconcileContext): Promise<void> => {
  const { config, now, report } = context;
  const stale = await stalePendingClaims(config, new Date(now - PENDING_WITHOUT_PAYOUT_EXPIRES_AFTER_MS));
  for (const claim of stale)
    await runStep(report, `pending claim ${claim.id}`, () => expireIfWithoutPayout(context, claim));
};

export const reconcilePayouts = async (
  ledger: PayoutLedger,
  chain: PayoutChain,
  config: SupabaseConfig,
): Promise<ReconcileReport> => {
  const context: ReconcileContext = { ledger, chain, config, now: Date.now(), report: emptyReport() };
  const { report } = context;
  const outstanding = ledger.outstanding();
  if (outstanding.length > 0)
    await runStep(report, "outstanding payouts", async () => {
      const confirmedTransactionCount = await transactionCount(chain, "latest");
      for (const entry of outstanding)
        await runStep(report, `payout ${entry.claimId}`, () =>
          reconcileOutstanding(context, entry, confirmedTransactionCount),
        );
    });
  for (const entry of ledger.unrecordedFinal())
    if (await retryRecording(ledger, config, entry)) report.recorded += 1;
  await runStep(report, "stale pending claims", () => expirePendingWithoutPayout(context));
  return report;
};
