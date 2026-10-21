import type { EligibilitySettings } from "../config/types";
import type { SocialLinkRow } from "../supabase/types";
import type { EligibilityChecks, EligibilityResult } from "./types";

type EligibilityProfile = Pick<
  SocialLinkRow,
  "verified_type" | "is_identity_verified" | "verified_followers_count" | "followers_count" | "following_count"
>;

const passesVerification = (profile: EligibilityProfile, settings: EligibilitySettings): boolean =>
  (profile.verified_type !== null && settings.verifiedTypes.includes(profile.verified_type.toLowerCase())) ||
  (settings.acceptIdentityVerified && profile.is_identity_verified === true);

const passesVerifiedFollowers = (profile: EligibilityProfile, settings: EligibilitySettings): boolean =>
  (profile.verified_followers_count ?? 0) >= settings.minVerifiedFollowers;

const passesRatio = (profile: EligibilityProfile, settings: EligibilitySettings): boolean | null => {
  if (!settings.ratioCheckEnabled) return null;
  if (profile.followers_count === null || profile.following_count === null) return false;
  return profile.following_count <= settings.maxFollowingPerFollower * profile.followers_count;
};

export const evaluateEligibility = (
  profile: EligibilityProfile,
  settings: EligibilitySettings,
): EligibilityResult => {
  const checks: EligibilityChecks = {
    verified: passesVerification(profile, settings),
    verifiedFollowers: passesVerifiedFollowers(profile, settings),
    ratio: passesRatio(profile, settings),
  };
  if (!checks.verified) return { checks, rejectReason: "not_verified" };
  if (!checks.verifiedFollowers) return { checks, rejectReason: "no_verified_followers" };
  if (checks.ratio === false) return { checks, rejectReason: "ratio" };
  return { checks, rejectReason: null };
};
