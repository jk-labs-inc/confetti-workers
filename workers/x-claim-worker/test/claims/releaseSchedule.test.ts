import { describe, expect, it } from "vitest";
import { nextReleaseTime, releasedSpotsAt, spotsSnapshot } from "../../src/claims/releaseSchedule";

const BATCHES_OF_FIVE = { dailyLimit: 20, batchSize: 5, intervalHours: 6 };
const at = (time: string) => Date.parse(`2026-10-07T${time}Z`);
const iso = (time: number) => new Date(time).toISOString();

describe("release schedule", () => {
  it.each([
    ["00:00:00", 5, "2026-10-07T06:00:00.000Z"],
    ["05:59:59", 5, "2026-10-07T06:00:00.000Z"],
    ["06:00:00", 10, "2026-10-07T12:00:00.000Z"],
    ["12:00:00", 15, "2026-10-07T18:00:00.000Z"],
    ["18:30:00", 20, "2026-10-08T00:00:00.000Z"],
    ["23:59:59", 20, "2026-10-08T00:00:00.000Z"],
  ])("at %s releases %i spots, next release %s", (time, released, next) => {
    expect(releasedSpotsAt(at(time), BATCHES_OF_FIVE)).toBe(released);
    expect(iso(nextReleaseTime(at(time), BATCHES_OF_FIVE))).toBe(next);
  });

  it("carries unused spots over within the day", () => {
    expect(spotsSnapshot(at("12:00:00"), 3, BATCHES_OF_FIVE, false).open).toBe(12);
  });

  it("subtracts spots already used today", () => {
    expect(spotsSnapshot(at("06:30:00"), 7, BATCHES_OF_FIVE, false)).toEqual({
      open: 3,
      usedToday: 7,
      dailyLimit: 20,
      nextReleaseAt: "2026-10-07T12:00:00.000Z",
      paused: false,
    });
  });

  it("never reports negative open spots", () => {
    expect(spotsSnapshot(at("00:10:00"), 9, BATCHES_OF_FIVE, false).open).toBe(0);
  });

  it("reports no open spots while paused", () => {
    expect(spotsSnapshot(at("18:30:00"), 0, BATCHES_OF_FIVE, true).open).toBe(0);
  });

  it("releases everything at midnight when the batch covers the daily limit", () => {
    const allAtOnce = { dailyLimit: 20, batchSize: 20, intervalHours: 6 };
    expect(releasedSpotsAt(at("00:00:00"), allAtOnce)).toBe(20);
    expect(iso(nextReleaseTime(at("00:00:00"), allAtOnce))).toBe("2026-10-08T00:00:00.000Z");
  });

  it("rolls the next release to midnight when intervals do not divide the day", () => {
    const everyFiveHours = { dailyLimit: 40, batchSize: 5, intervalHours: 5 };
    expect(releasedSpotsAt(at("20:30:00"), everyFiveHours)).toBe(25);
    expect(iso(nextReleaseTime(at("20:30:00"), everyFiveHours))).toBe("2026-10-08T00:00:00.000Z");
  });
});
