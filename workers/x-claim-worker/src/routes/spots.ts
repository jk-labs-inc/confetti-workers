import { coordinatorStub } from "../claims/claimCoordinator";
import { errorResponse, jsonResponse } from "../http/responses";
import type { RouteContext } from "../http/types";

const SPOTS_CACHE_CONTROL = "public, max-age=15";

export const handleSpots = async ({ env, settings }: RouteContext) => {
  try {
    const spots = await coordinatorStub(env).spots();
    return jsonResponse(
      {
        open: spots.open,
        dailyLimit: spots.dailyLimit,
        usedToday: spots.usedToday,
        nextReleaseAt: spots.nextReleaseAt,
        paused: spots.paused,
        usdAmount: settings.payout.usdAmount,
        currency: settings.payout.currency,
        network: settings.payout.networkName,
      },
      200,
      { "Cache-Control": SPOTS_CACHE_CONTROL },
    );
  } catch (error) {
    console.error("spots lookup failed", error);
    return errorResponse("storage_unavailable", "Could not read spots", 503);
  }
};
