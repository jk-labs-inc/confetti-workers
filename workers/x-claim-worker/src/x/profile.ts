import { X_USER_FIELDS, X_USERS_ME_URL } from "./constants";
import { XApiError } from "./errors";
import type { XProfile } from "./types";

const optionalBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const optionalCount = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
};

export const parseXProfile = (body: unknown): XProfile => {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data.id !== "string" || typeof data.username !== "string")
    throw new XApiError("X users/me response has no user");

  const metrics = (data.public_metrics ?? {}) as Record<string, unknown>;
  return {
    id: data.id,
    username: data.username,
    verified: optionalBoolean(data.verified),
    verifiedType: optionalString(data.verified_type),
    isIdentityVerified: optionalBoolean(data.is_identity_verified),
    subscriptionType: optionalString(data.subscription_type),
    verifiedFollowersCount: optionalCount(data.verified_followers_count),
    followersCount: optionalCount(metrics.followers_count),
    followingCount: optionalCount(metrics.following_count),
    postCount: optionalCount(metrics.post_count) ?? optionalCount(metrics.tweet_count),
    createdAt: optionalString(data.created_at),
  };
};

export const fetchMe = async (accessToken: string): Promise<XProfile> => {
  const url = new URL(X_USERS_ME_URL);
  url.searchParams.set("user.fields", X_USER_FIELDS);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok)
    throw new XApiError(`X users/me failed with ${response.status}`);
  return parseXProfile(await response.json());
};
