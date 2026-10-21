import { describe, expect, it } from "vitest";
import { parseXProfile } from "../../src/x/profile";

const user = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: "123",
    username: "alice",
    verified: true,
    verified_type: "blue",
    verified_followers_count: 4,
    public_metrics: { followers_count: 400, following_count: 300, post_count: 1200 },
    ...overrides,
  },
});

describe("parseXProfile", () => {
  it("reads the post count from tweet_count when post_count is absent", () => {
    const profile = parseXProfile(
      user({ public_metrics: { followers_count: 1, following_count: 2, tweet_count: 77 } }),
    );

    expect(profile.postCount).toBe(77);
  });

  it("accepts verified_followers_count sent as a string", () => {
    expect(parseXProfile(user({ verified_followers_count: "12" })).verifiedFollowersCount).toBe(12);
  });
});
