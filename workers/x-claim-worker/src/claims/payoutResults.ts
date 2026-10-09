import type { Hex } from "viem";
import type { PayoutLedger } from "../payout/ledger";
import type { LedgerEntry, LedgerState } from "../payout/types";
import { getClaim, updateClaim } from "../supabase/claimsHistory";
import type { ClaimStatus, SupabaseConfig } from "../supabase/types";

export type FinalLedgerState = Extract<LedgerState, "confirmed" | "failed" | "abandoned">;

const claimStatusFor = (state: FinalLedgerState): ClaimStatus => (state === "confirmed" ? "paid" : "failed");

const writeClaimStatus = async (
  ledger: PayoutLedger,
  config: SupabaseConfig,
  claimId: string,
  state: FinalLedgerState,
  confirmedHash: Hex | null,
): Promise<boolean> => {
  if (state === "abandoned") {
    ledger.markRecorded(claimId);
    return true;
  }
  const status = claimStatusFor(state);
  try {
    await updateClaim(config, claimId, confirmedHash ? { status, tx_hash: confirmedHash } : { status });
    ledger.markRecorded(claimId);
    return true;
  } catch (error) {
    console.error("recording payout result failed; reconcile will retry", claimId, error);
    return false;
  }
};

export const recordPayoutResult = async (
  ledger: PayoutLedger,
  config: SupabaseConfig,
  claimId: string,
  state: FinalLedgerState,
  confirmedHash: Hex | null,
): Promise<void> => {
  ledger.setState(claimId, state, Date.now(), confirmedHash);
  await writeClaimStatus(ledger, config, claimId, state, confirmedHash);
};

export const abandonIfUnreserved = async (
  ledger: PayoutLedger,
  config: SupabaseConfig,
  entry: LedgerEntry,
): Promise<boolean> => {
  if (entry.state !== "signed" || (await getClaim(config, entry.claimId))) return false;
  await recordPayoutResult(ledger, config, entry.claimId, "abandoned", null);
  return true;
};

export const retryRecording = (
  ledger: PayoutLedger,
  config: SupabaseConfig,
  entry: LedgerEntry,
): Promise<boolean> =>
  writeClaimStatus(ledger, config, entry.claimId, entry.state as FinalLedgerState, entry.confirmedHash);
