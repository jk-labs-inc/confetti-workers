import type { RejectReason } from "../supabase/types";

export interface SpotsSnapshot {
  open: number;
  usedToday: number;
  dailyLimit: number;
  nextReleaseAt: string;
  paused: boolean;
}

export interface UsedTodayCache {
  dayStart: number;
  fetchedAt: number;
  usedToday: Promise<number>;
}

export interface PriceCache {
  usdPrice: string;
  fetchedAt: number;
}

export interface EligibilityChecks {
  verified: boolean;
  verifiedFollowers: boolean;
  ratio: boolean | null;
}

export type EligibilityRejectReason = Extract<RejectReason, "not_verified" | "no_verified_followers" | "ratio">;

export interface EligibilityResult {
  checks: EligibilityChecks;
  rejectReason: EligibilityRejectReason | null;
}

export interface PaidDetails {
  claimId: string;
  txHash: string;
  tokenAmount: string;
  usdAmount: string;
  currency: string;
  network: string;
}

export type ClaimOutcome =
  | ({ outcome: "paid" | "pending" } & PaidDetails)
  | { outcome: "rejected"; reason: RejectReason; nextReleaseAt?: string }
  | { outcome: "payout_failed" };

export type Reservation =
  | { kind: "rejected"; reason: RejectReason; nextReleaseAt?: string }
  | { kind: "settled"; outcome: ClaimOutcome }
  | { kind: "sent"; details: PaidDetails };

export interface ReconcileReport {
  confirmed: number;
  failed: number;
  abandoned: number;
  rebroadcast: number;
  replaced: number;
  recorded: number;
  expiredPending: number;
  failedSteps: number;
}

export interface MaintenanceReport extends ReconcileReport {
  lowBalanceAlerted: boolean;
}
