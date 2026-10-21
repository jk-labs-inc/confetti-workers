import { X_PLATFORM } from "../x/constants";
import { allRows, exactCount, onlyRow, RETURN_REPRESENTATION, selectFirst, supabaseRequest } from "./client";
import type { ClaimPatch, ClaimRow, NewClaim, SupabaseConfig } from "./types";

const TABLE = "claims_history";
const STALE_PENDING_BATCH_SIZE = "100";
const ACTIVE_CLAIM_STATUSES = ["pending", "paid"] as const;

const activeStatusFilter = `in.(${ACTIVE_CLAIM_STATUSES.join(",")})`;

export const countActiveClaimsSince = async (
  config: SupabaseConfig,
  since: Date,
): Promise<number> =>
  exactCount(
    await supabaseRequest(
      config,
      "HEAD",
      TABLE,
      new URLSearchParams({
        select: "id",
        status: activeStatusFilter,
        created_at: `gte.${since.toISOString()}`,
      }),
      { prefer: ["count=exact"] },
    ),
  );

const findActiveClaim = (
  config: SupabaseConfig,
  filter: Record<string, string>,
): Promise<ClaimRow | null> => selectFirst(config, TABLE, { status: activeStatusFilter, ...filter });

export const activeClaimForAddress = (config: SupabaseConfig, address: string): Promise<ClaimRow | null> =>
  findActiveClaim(config, { address: `eq.${address}` });

export const hasActiveClaim = async (
  config: SupabaseConfig,
  address: string,
  platformUserId: string,
): Promise<boolean> => {
  const [byWallet, byAccount] = await Promise.all([
    activeClaimForAddress(config, address),
    findActiveClaim(config, { platform: `eq.${X_PLATFORM}`, platform_user_id: `eq.${platformUserId}` }),
  ]);
  return byWallet !== null || byAccount !== null;
};

export const insertClaim = async (config: SupabaseConfig, claim: NewClaim): Promise<ClaimRow> =>
  onlyRow(
    await supabaseRequest(config, "POST", TABLE, new URLSearchParams(), {
      body: { platform: X_PLATFORM, ...claim },
      ...RETURN_REPRESENTATION,
    }),
  );

export const updateClaim = async (
  config: SupabaseConfig,
  id: string,
  patch: ClaimPatch,
): Promise<void> => {
  await supabaseRequest(config, "PATCH", TABLE, new URLSearchParams({ id: `eq.${id}` }), {
    body: patch,
  });
};

export const getClaim = (config: SupabaseConfig, id: string): Promise<ClaimRow | null> =>
  selectFirst(config, TABLE, { id: `eq.${id}` });

export const latestClaimForAddress = (config: SupabaseConfig, address: string): Promise<ClaimRow | null> =>
  selectFirst(config, TABLE, { address: `eq.${address}`, order: "created_at.desc" });

export const stalePendingClaims = async (
  config: SupabaseConfig,
  createdBefore: Date,
): Promise<ClaimRow[]> =>
  allRows(
    await supabaseRequest(
      config,
      "GET",
      TABLE,
      new URLSearchParams({
        select: "*",
        status: "eq.pending",
        created_at: `lt.${createdBefore.toISOString()}`,
        order: "created_at.asc",
        limit: STALE_PENDING_BATCH_SIZE,
      }),
    ),
  );
