import { coordinatorStub } from "../claims/claimCoordinator";
import { evaluateEligibility } from "../claims/eligibility";
import type { EligibilityResult, SpotsSnapshot } from "../claims/types";
import { errorResponse, jsonResponse, NO_STORE } from "../http/responses";
import type { RouteContext } from "../http/types";
import { activeClaimForAddress, latestClaimForAddress } from "../supabase/claimsHistory";
import { latestLinkForAddress } from "../supabase/socialLinks";
import type { ClaimRow, SocialLinkRow } from "../supabase/types";
import { verifyWalletProof } from "../walletProof/verify";
import { X_PLATFORM } from "../x/constants";
import { outcomeJson } from "./claimOutcome";

const optionalText = (value: string | number | null): string | null => (value === null ? null : String(value));

const linkView = (link: SocialLinkRow, eligibility: EligibilityResult) => ({
  platform: X_PLATFORM,
  handle: link.handle,
  linkedAt: link.created_at,
  updatedAt: link.updated_at,
  verifiedType: link.verified_type,
  verifiedFollowersCount: link.verified_followers_count,
  followersCount: link.followers_count,
  followingCount: link.following_count,
  checks: eligibility.checks,
  eligible: eligibility.rejectReason === null,
  rejectReason: eligibility.rejectReason,
});

const claimView = (claim: ClaimRow) => ({
  status: claim.status,
  rejectReason: claim.reject_reason,
  txHash: claim.tx_hash,
  tokenAmount: optionalText(claim.token_amount),
  usdAmount: optionalText(claim.usd_amount),
  currency: claim.currency,
  network: claim.network_name,
  createdAt: claim.created_at,
});

export const handleClaimMe = async ({ request, env, settings }: RouteContext) => {
  const address = await verifyWalletProof(request, env, settings);

  let lookups: [SocialLinkRow | null, ClaimRow | null, ClaimRow | null, SpotsSnapshot];
  try {
    lookups = await Promise.all([
      latestLinkForAddress(settings.supabase, address),
      activeClaimForAddress(settings.supabase, address),
      latestClaimForAddress(settings.supabase, address),
      coordinatorStub(env).spots(),
    ]);
  } catch (error) {
    console.error("claim state lookup failed", error);
    return errorResponse("storage_unavailable", "Could not read the claim state", 503);
  }
  const [link, activeClaim, latestClaim, spots] = lookups;
  const eligibility = link ? evaluateEligibility(link, settings.eligibility) : null;
  const claim = activeClaim ?? latestClaim;

  return jsonResponse(
    {
      address,
      link: link && eligibility ? linkView(link, eligibility) : null,
      claim: claim ? claimView(claim) : null,
      canClaim: eligibility?.rejectReason === null && activeClaim === null && spots.open > 0,
      spots: { open: spots.open, nextReleaseAt: spots.nextReleaseAt, paused: spots.paused },
    },
    200,
    NO_STORE,
  );
};

export const handleClaim = async (context: RouteContext) => {
  const { request, env, settings } = context;
  const address = await verifyWalletProof(request, env, settings);
  const link = await latestLinkForAddress(settings.supabase, address);
  if (!link) return errorResponse("not_linked", "Link an X account with /x/start first", 409);

  try {
    const outcome = await coordinatorStub(env).claim(link);
    return jsonResponse(outcomeJson(outcome), 200, NO_STORE);
  } catch (error) {
    console.error("claim failed", error);
    return errorResponse("storage_unavailable", "Could not complete the claim, try again", 503);
  }
};
