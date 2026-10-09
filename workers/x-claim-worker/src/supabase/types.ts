export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export type SupabaseMethod = "GET" | "HEAD" | "POST" | "PATCH";

export interface SupabaseRequestOptions {
  body?: unknown;
  prefer?: string[];
}

export interface SupabaseResponse {
  headers: Headers;
  body: unknown;
}

export interface SocialLinkRow {
  id: string;
  created_at: string;
  updated_at: string;
  address: string;
  platform: string;
  platform_user_id: string;
  handle: string;
  verified: boolean | null;
  verified_type: string | null;
  is_identity_verified: boolean | null;
  subscription_type: string | null;
  verified_followers_count: number | null;
  followers_count: number | null;
  following_count: number | null;
  post_count: number | null;
  account_created_at: string | null;
}

export type SocialLinkProfile = Pick<
  SocialLinkRow,
  | "platform_user_id"
  | "handle"
  | "verified"
  | "verified_type"
  | "is_identity_verified"
  | "subscription_type"
  | "verified_followers_count"
  | "followers_count"
  | "following_count"
  | "post_count"
  | "account_created_at"
>;

export type ClaimStatus = "pending" | "paid" | "failed" | "rejected";

export type RejectReason =
  | "not_verified"
  | "no_verified_followers"
  | "ratio"
  | "x_linked_elsewhere"
  | "wallet_claimed"
  | "no_spots"
  | "paused";

export interface ClaimRow {
  id: string;
  created_at: string;
  address: string;
  platform: string;
  platform_user_id: string;
  status: ClaimStatus;
  reject_reason: RejectReason | null;
  usd_amount: string | number | null;
  token_amount: string | number | null;
  usd_price: string | number | null;
  currency: string | null;
  network_name: string | null;
  tx_hash: string | null;
}

export type NewClaim = Pick<ClaimRow, "address" | "platform_user_id" | "status"> &
  Partial<
    Pick<
      ClaimRow,
      | "id"
      | "reject_reason"
      | "usd_amount"
      | "token_amount"
      | "usd_price"
      | "currency"
      | "network_name"
      | "tx_hash"
    >
  >;

export type ClaimPatch = Partial<Pick<ClaimRow, "status" | "tx_hash">>;
