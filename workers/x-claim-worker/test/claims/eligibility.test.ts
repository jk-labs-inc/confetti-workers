import { describe, expect, it } from "vitest";
import { evaluateEligibility } from "../../src/claims/eligibility";
import type { EligibilitySettings } from "../../src/config/types";

const DEFAULTS: EligibilitySettings = {
  verifiedTypes: ["blue", "business", "government"],
  acceptIdentityVerified: false,
  minVerifiedFollowers: 1,
  ratioCheckEnabled: true,
  maxFollowingPerFollower: 10,
};

const profile = (overrides: Record<string, unknown> = {}) => ({
  verified_type: "blue",
  is_identity_verified: false,
  verified_followers_count: 1,
  followers_count: 500,
  following_count: 5000,
  ...overrides,
});

describe("evaluateEligibility", () => {
  it.each(["blue", "business", "government", "Blue"])("passes a %s account", (verified_type) => {
    expect(evaluateEligibility(profile({ verified_type }), DEFAULTS)).toEqual({
      checks: { verified: true, verifiedFollowers: true, ratio: true },
      rejectReason: null,
    });
  });

  it.each(["none", null])("fails an account whose verified_type is %s", (verified_type) => {
    expect(evaluateEligibility(profile({ verified_type }), DEFAULTS).rejectReason).toBe("not_verified");
  });

  it("only counts the verification types in the settings", () => {
    const blueOnly = { ...DEFAULTS, verifiedTypes: ["blue"] };

    expect(evaluateEligibility(profile({ verified_type: "business" }), blueOnly).rejectReason).toBe("not_verified");
  });

  it("accepts ID verification instead when the setting allows it", () => {
    const unverifiedWithId = profile({ verified_type: "none", is_identity_verified: true });

    expect(evaluateEligibility(unverifiedWithId, DEFAULTS).rejectReason).toBe("not_verified");
    expect(evaluateEligibility(unverifiedWithId, { ...DEFAULTS, acceptIdentityVerified: true }).rejectReason).toBeNull();
  });

  it.each([0, null])("fails an account with %s verified followers", (count) => {
    expect(evaluateEligibility(profile({ verified_followers_count: count }), DEFAULTS).rejectReason).toBe(
      "no_verified_followers",
    );
  });

  it("allows following exactly ten times the followers", () => {
    expect(evaluateEligibility(profile({ following_count: 5000, followers_count: 500 }), DEFAULTS).rejectReason).toBeNull();
  });

  it("fails following more than ten times the followers", () => {
    expect(evaluateEligibility(profile({ following_count: 5001, followers_count: 500 }), DEFAULTS).rejectReason).toBe(
      "ratio",
    );
  });

  it("fails the ratio when X sent no counts", () => {
    expect(evaluateEligibility(profile({ followers_count: null }), DEFAULTS).rejectReason).toBe("ratio");
  });

  it("skips the ratio when it is switched off", () => {
    const result = evaluateEligibility(profile({ following_count: 9999, followers_count: 1 }), {
      ...DEFAULTS,
      ratioCheckEnabled: false,
    });

    expect(result).toEqual({ checks: { verified: true, verifiedFollowers: true, ratio: null }, rejectReason: null });
  });

  it("reports the first failing check while still showing every check", () => {
    expect(evaluateEligibility(profile({ verified_type: "none", verified_followers_count: 0 }), DEFAULTS)).toEqual({
      checks: { verified: false, verifiedFollowers: false, ratio: true },
      rejectReason: "not_verified",
    });
  });
});
