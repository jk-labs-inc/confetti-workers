import type { Chain, Hex } from "viem";
import type { SupabaseConfig } from "../supabase/types";

export interface EligibilitySettings {
  verifiedTypes: string[];
  acceptIdentityVerified: boolean;
  minVerifiedFollowers: number;
  ratioCheckEnabled: boolean;
  maxFollowingPerFollower: number;
}

export interface ReleaseSettings {
  dailyLimit: number;
  batchSize: number;
  intervalHours: number;
}

export interface PayoutSettings {
  chain: Chain;
  networkName: string;
  currency: string;
  priceSymbol: string;
  usdAmount: string;
  maxTokenAmountPerClaim: string;
  confirmWaitSeconds: number;
  privateKey: Hex;
  rpcUrl: string;
  alchemyApiKey: string;
}

export interface Settings {
  allowedOrigins: string[];
  xRedirectUri: string;
  xClientId: string;
  xClientSecret: string;
  paraJwksUrl: string;
  paraJwtAudience: string;
  supabase: SupabaseConfig;
  claimsPaused: boolean;
  release: ReleaseSettings;
  eligibility: EligibilitySettings;
  payout: PayoutSettings;
  lowBalanceAlertUsd: string;
  lowBalanceAlertIntervalHours: number;
}
