import type { ClaimOutcome } from "../claims/types";

export const CLAIM_OUTCOME_PARAM = "x_claim";

export type OutcomeParams = Record<string, string | undefined>;

export const outcomeJson = (outcome: ClaimOutcome) => {
  switch (outcome.outcome) {
    case "paid":
    case "pending":
      return {
        outcome: outcome.outcome,
        txHash: outcome.txHash,
        tokenAmount: outcome.tokenAmount,
        usdAmount: outcome.usdAmount,
        currency: outcome.currency,
        network: outcome.network,
      };
    case "rejected":
      return { outcome: "rejected", reason: outcome.reason, nextReleaseAt: outcome.nextReleaseAt };
    case "payout_failed":
      return { outcome: "payout_failed" };
  }
};

export const outcomeParams = (outcome: ClaimOutcome): OutcomeParams => {
  switch (outcome.outcome) {
    case "paid":
    case "pending":
      return {
        [CLAIM_OUTCOME_PARAM]: outcome.outcome,
        tx: outcome.txHash,
        amount: outcome.tokenAmount,
        currency: outcome.currency,
        network: outcome.network,
      };
    case "rejected":
      return { [CLAIM_OUTCOME_PARAM]: outcome.reason, next_release_at: outcome.nextReleaseAt };
    case "payout_failed":
      return { [CLAIM_OUTCOME_PARAM]: "payout_failed" };
  }
};
