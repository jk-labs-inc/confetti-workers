import { X_PLATFORM } from "../x/constants";
import { onlyRow, RETURN_REPRESENTATION, selectFirst, supabaseRequest } from "./client";
import type { SocialLinkProfile, SocialLinkRow, SupabaseConfig } from "./types";

const TABLE = "social_links";

export const findLinkByPlatformUser = (
  config: SupabaseConfig,
  platformUserId: string,
): Promise<SocialLinkRow | null> =>
  selectFirst(config, TABLE, { platform: `eq.${X_PLATFORM}`, platform_user_id: `eq.${platformUserId}` });

export const latestLinkForAddress = (
  config: SupabaseConfig,
  address: string,
): Promise<SocialLinkRow | null> =>
  selectFirst(config, TABLE, {
    platform: `eq.${X_PLATFORM}`,
    address: `eq.${address}`,
    order: "updated_at.desc",
  });

export const insertLink = async (
  config: SupabaseConfig,
  address: string,
  profile: SocialLinkProfile,
): Promise<SocialLinkRow> =>
  onlyRow(
    await supabaseRequest(config, "POST", TABLE, new URLSearchParams(), {
      body: { address, platform: X_PLATFORM, ...profile },
      ...RETURN_REPRESENTATION,
    }),
  );

export const refreshLinkProfile = async (
  config: SupabaseConfig,
  id: string,
  profile: SocialLinkProfile,
): Promise<SocialLinkRow> =>
  onlyRow(
    await supabaseRequest(config, "PATCH", TABLE, new URLSearchParams({ id: `eq.${id}` }), {
      body: { ...profile, updated_at: new Date().toISOString() },
      ...RETURN_REPRESENTATION,
    }),
  );
