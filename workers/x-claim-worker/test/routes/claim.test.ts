import { describe, expect, it } from "vitest";
import { X_API_ORIGIN, xUser } from "../fakes/xApi";
import { TEST_DAILY_LIMIT, TEST_SUPABASE_URL } from "../support/bindings";
import { fillTodaysSpots, seedLink, useClaimNetwork } from "../support/claimNetwork";
import { callWorker, captureErrorLogs, proofPost } from "../support/harness";
import { paraProof, randomAddress } from "../support/proofs";
import { linkWithX } from "../support/xLogin";

const fakes = useClaimNetwork();

const claimMe = async (address: string) =>
  callWorker("/claim/me", { headers: { "X-Wallet-Proof": await paraProof(address) } });

const postClaim = (proof: string) => callWorker("/claim", proofPost(proof));

const linkThroughX = async (address: string, user = xUser()) =>
  (await linkWithX(fakes.x, address, user)).searchParams.get("x_claim");

describe("GET /claim/me", () => {
  it("shows an unlinked wallet with the open spots", async () => {
    const response = await claimMe(randomAddress());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      address: expect.stringMatching(/^0x[0-9a-f]{40}$/),
      link: null,
      claim: null,
      canClaim: false,
      spots: { open: TEST_DAILY_LIMIT, nextReleaseAt: expect.any(String), paused: false },
    });
  });

  it("shows a linked, eligible wallet that can claim", async () => {
    const link = seedLink(fakes.postgrest, { handle: "alice" });

    const body = (await (await claimMe(link.address)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      link: {
        platform: "x",
        handle: "alice",
        verifiedType: "blue",
        verifiedFollowersCount: 3,
        checks: { verified: true, verifiedFollowers: true, ratio: true },
        eligible: true,
        rejectReason: null,
      },
      claim: null,
      canClaim: true,
    });
  });

  it("shows the paid claim after the X round trip", async () => {
    const address = randomAddress();
    await linkThroughX(address);

    const body = (await (await claimMe(address)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      claim: {
        status: "paid",
        rejectReason: null,
        txHash: fakes.chain.mined[0]?.hash,
        tokenAmount: "20",
        usdAmount: "5",
        currency: "POL",
        network: "polygon",
      },
      canClaim: false,
    });
  });

  it("tells a wallet whose X account belongs to another wallet", async () => {
    const user = xUser();
    await linkThroughX(randomAddress(), user);
    const second = randomAddress();
    await linkThroughX(second, user);

    const body = (await (await claimMe(second)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ link: null, claim: { status: "rejected", rejectReason: "x_linked_elsewhere" } });
  });

});

describe("POST /claim", () => {
  it("refuses a wallet without a linked X account", async () => {
    const response = await postClaim(await paraProof(randomAddress()));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "not_linked" });
  });

  it("claims after spots reopen without a second X login", async () => {
    const used = fillTodaysSpots(fakes.postgrest);
    const address = randomAddress();
    expect(await linkThroughX(address)).toBe("no_spots");
    used[0]!.status = "failed";
    const xRequestsBefore = fakes.network.requestsTo(X_API_ORIGIN).length;

    const response = await postClaim(await paraProof(address));

    expect(await response.json()).toEqual({
      outcome: "paid",
      txHash: fakes.chain.mined[0]?.hash,
      tokenAmount: "20",
      usdAmount: "5",
      currency: "POL",
      network: "polygon",
    });
    expect(fakes.network.requestsTo(X_API_ORIGIN)).toHaveLength(xRequestsBefore);
  });
});

describe("storage outage", () => {
  it("answers 503 storage_unavailable when Supabase cannot be reached", async () => {
    captureErrorLogs();
    fakes.network.route(TEST_SUPABASE_URL, () => {
      throw new TypeError("Network connection lost.");
    });

    const response = await postClaim(await paraProof(randomAddress()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "storage_unavailable" });
  });
});

describe("wallet proof", () => {
  it.each([
    ["GET", "/claim/me"],
    ["POST", "/claim"],
  ])("is required for %s %s", async (method, path) => {
    const response = await callWorker(path, { method });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_proof" });
  });
});
