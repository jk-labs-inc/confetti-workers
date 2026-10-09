import { SupabaseError } from "../supabase/client";
import { findLinkByPlatformUser, insertLink, refreshLinkProfile } from "../supabase/socialLinks";
import type { SocialLinkProfile, SocialLinkRow, SupabaseConfig } from "../supabase/types";
import type { XProfile } from "../x/types";
import type { LinkResult } from "./types";

const linkColumns = (profile: XProfile): SocialLinkProfile => ({
  platform_user_id: profile.id,
  handle: profile.username,
  verified: profile.verified,
  verified_type: profile.verifiedType,
  is_identity_verified: profile.isIdentityVerified,
  subscription_type: profile.subscriptionType,
  verified_followers_count: profile.verifiedFollowersCount,
  followers_count: profile.followersCount,
  following_count: profile.followingCount,
  post_count: profile.postCount,
  account_created_at: profile.createdAt,
});

const linkResultFor = (link: SocialLinkRow, address: string): LinkResult =>
  link.address === address ? { kind: "linked", link } : { kind: "linked_elsewhere" };

export const linkXAccount = async (
  config: SupabaseConfig,
  address: string,
  profile: XProfile,
): Promise<LinkResult> => {
  const columns = linkColumns(profile);
  const existing = await findLinkByPlatformUser(config, profile.id);
  if (existing)
    return linkResultFor(await refreshLinkProfile(config, existing.id, columns), address);

  try {
    return { kind: "linked", link: await insertLink(config, address, columns) };
  } catch (error) {
    if (!(error instanceof SupabaseError && error.isUniqueViolation)) throw error;
    const winner = await findLinkByPlatformUser(config, profile.id);
    if (!winner) throw error;
    return linkResultFor(winner, address);
  }
};
