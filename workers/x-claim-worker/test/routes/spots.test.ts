import { describe, expect, it } from "vitest";
import { FakePostgrest } from "../fakes/postgrest";
import { TEST_APP_ORIGIN, TEST_DAILY_LIMIT, TEST_SUPABASE_KEY, TEST_SUPABASE_URL } from "../support/bindings";
import { callWorker, useFakeNetwork } from "../support/harness";
import { randomAddress } from "../support/proofs";

let postgrest: FakePostgrest;
useFakeNetwork((network) => {
  postgrest = new FakePostgrest(TEST_SUPABASE_KEY);
  network.route(TEST_SUPABASE_URL, postgrest.handle);
});

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

const seedClaim = (status: string, createdAt?: string) =>
  postgrest.seed("claims_history", {
    address: randomAddress(),
    platform_user_id: crypto.randomUUID(),
    status,
    ...(createdAt ? { created_at: createdAt } : {}),
  });

describe("GET /spots", () => {
  it("counts today's pending and paid claims against the released spots", async () => {
    seedClaim("paid");
    seedClaim("pending");
    seedClaim("failed");
    seedClaim("rejected");
    seedClaim("paid", YESTERDAY);

    const response = await callWorker("/spots");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      open: TEST_DAILY_LIMIT - 2,
      dailyLimit: TEST_DAILY_LIMIT,
      usedToday: 2,
      nextReleaseAt: expect.stringMatching(/T00:00:00\.000Z$/),
      paused: false,
      usdAmount: "5",
      currency: "POL",
      network: "polygon",
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=15");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(TEST_APP_ORIGIN);
  });

  it("rejects a disallowed origin", async () => {
    const response = await callWorker("/spots", { origin: "https://evil.test" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "origin_not_allowed" });
  });
});
