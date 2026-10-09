import type { ReleaseSettings } from "../config/types";
import type { SpotsSnapshot } from "./types";

export const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const utcDayStart = (now: number): number => now - (now % MS_PER_DAY);

const intervalMs = (release: ReleaseSettings): number =>
  release.intervalHours * MS_PER_HOUR;

const intervalsElapsedToday = (now: number, release: ReleaseSettings): number =>
  Math.floor((now - utcDayStart(now)) / intervalMs(release));

export const releasedSpotsAt = (now: number, release: ReleaseSettings): number =>
  Math.min(
    release.dailyLimit,
    release.batchSize * (intervalsElapsedToday(now, release) + 1),
  );

export const nextReleaseTime = (now: number, release: ReleaseSettings): number => {
  const dayStart = utcDayStart(now);
  const tomorrow = dayStart + MS_PER_DAY;
  if (releasedSpotsAt(now, release) >= release.dailyLimit) return tomorrow;
  const nextBatch =
    dayStart + (intervalsElapsedToday(now, release) + 1) * intervalMs(release);
  return Math.min(nextBatch, tomorrow);
};

export const spotsSnapshot = (
  now: number,
  usedToday: number,
  release: ReleaseSettings,
  paused: boolean,
): SpotsSnapshot => {
  return {
    open: paused ? 0 : Math.max(0, releasedSpotsAt(now, release) - usedToday),
    usedToday,
    dailyLimit: release.dailyLimit,
    nextReleaseAt: new Date(nextReleaseTime(now, release)).toISOString(),
    paused,
  };
};
