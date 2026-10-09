import { parseEther, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { SocialLinkRow } from "../../src/supabase/types";
import { unavailableRpc } from "../fakes/chain";
import { TEST_DAILY_LIMIT, TEST_RPC_URL } from "../support/bindings";
import {
  claimFor,
  claimWithSettings,
  fillTodaysSpots,
  ledgerRows,
  runMaintenance,
  seedLink,
  useClaimNetwork,
  writeCrashedReservation,
} from "../support/claimNetwork";
import { captureErrorLogs } from "../support/harness";
import { randomAddress } from "../support/proofs";

const fakes = useClaimNetwork();

const claimRows = () => fakes.postgrest.rows("claims_history");

describe("claim: check, reserve, pay, record", () => {
  it("pays $5 worth of POL and records the paid claim", async () => {
    const link = seedLink(fakes.postgrest);

    const outcome = await claimFor(link);

    expect(outcome).toEqual({
      outcome: "paid",
      claimId: expect.any(String),
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      tokenAmount: "20",
      usdAmount: "5",
      currency: "POL",
      network: "polygon",
    });
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
    expect(claimRows()).toEqual([
      expect.objectContaining({
        address: link.address,
        platform_user_id: link.platform_user_id,
        status: "paid",
        usd_amount: "5",
        token_amount: "20",
        usd_price: "0.25",
        currency: "POL",
        network_name: "polygon",
        tx_hash: outcome.outcome === "paid" ? outcome.txHash : "",
      }),
    ]);
    expect(await ledgerRows()).toEqual([expect.objectContaining({ state: "confirmed", recorded: 1 })]);
  });

  it.each([
    ["not_verified", { verified_type: "none" }],
    ["no_verified_followers", { verified_followers_count: 0 }],
    ["ratio", { following_count: 5000, followers_count: 400 }],
  ] as const)("rejects as %s and records the attempt", async (reason, overrides) => {
    const link = seedLink(fakes.postgrest, overrides);

    expect(await claimFor(link)).toEqual({ outcome: "rejected", reason });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "rejected", reject_reason: reason })]);
    expect(fakes.chain.accepted).toHaveLength(0);
  });

  it("rejects every claim while the kill switch is on", async () => {
    const link = seedLink(fakes.postgrest);

    expect(await claimWithSettings({ CLAIMS_PAUSED: "true" }, link)).toEqual({ outcome: "rejected", reason: "paused" });
    expect(fakes.chain.accepted).toHaveLength(0);
  });

  it.each([
    ["wallet", (link: SocialLinkRow) => ({ address: link.address, platform_user_id: "other" })],
    ["X account", (link: SocialLinkRow) => ({ address: randomAddress().toLowerCase(), platform_user_id: link.platform_user_id })],
  ])("rejects a claim whose %s has already been paid", async (_, earlierClaim) => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.seed("claims_history", { ...earlierClaim(link), status: "paid" });

    expect(await claimFor(link)).toEqual({ outcome: "rejected", reason: "wallet_claimed" });
  });

  it("lets a wallet whose earlier payout failed claim again", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.seed("claims_history", { address: link.address, platform_user_id: link.platform_user_id, status: "failed" });

    expect((await claimFor(link)).outcome).toBe("paid");
  });

  it("rejects with the next release time once today's spots are used", async () => {
    fillTodaysSpots(fakes.postgrest);

    const outcome = await claimFor(seedLink(fakes.postgrest));

    expect(outcome).toEqual({
      outcome: "rejected",
      reason: "no_spots",
      nextReleaseAt: expect.stringMatching(/T00:00:00\.000Z$/),
    });
  });

  it("treats a unique-index conflict at reservation as already claimed and sends nothing", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.failNextWithUniqueViolation("claims_history");

    expect(await claimFor(link)).toEqual({ outcome: "rejected", reason: "wallet_claimed" });
    expect(fakes.chain.accepted).toHaveLength(0);
    expect(await ledgerRows()).toEqual([]);
  });

  it("pays the claim when its row was written but the answer to the insert was lost", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.failNextAfterCommit("POST", "claims_history");

    expect((await claimFor(link)).outcome).toBe("paid");
    expect(claimRows()).toEqual([expect.objectContaining({ status: "paid" })]);
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
  });

  it("sends nothing and leaves no claim behind when the claim row could not be written", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.failNext("POST", "claims_history");

    await expect(Promise.resolve(claimFor(link))).rejects.toThrow("Injected failure");
    expect(fakes.chain.accepted).toHaveLength(0);
    expect(claimRows()).toEqual([]);

    expect((await claimFor(link)).outcome).toBe("paid");
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0]);
    expect((await ledgerRows()).map((row) => [row.state, row.nonce]).sort()).toEqual([
      ["abandoned", 0],
      ["confirmed", 0],
    ]);
  });
});

describe("claim: payout failures", () => {
  it("marks the claim failed and frees the slot when the node rejects the transfer", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.chain.failNextSend({ kind: "rpc", message: "insufficient funds for gas * price + value" });

    expect(await claimFor(link)).toEqual({ outcome: "payout_failed" });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(await ledgerRows()).toEqual([expect.objectContaining({ state: "failed", recorded: 1 })]);
    expect((await claimFor(link)).outcome).toBe("paid");
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0]);
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
  });

  it("keeps the slot when the provider errors after the node accepted the transfer, so the wallet is paid once", async () => {
    fakes.chain.autoMine = false;
    const link = seedLink(fakes.postgrest);
    fakes.chain.failNextSend({ kind: "accept_then_rpc", message: "Internal error" });

    expect((await claimFor(link)).outcome).toBe("pending");
    expect(await claimFor(link)).toEqual({ outcome: "rejected", reason: "wallet_claimed" });

    fakes.chain.mine();
    expect(await runMaintenance()).toMatchObject({ confirmed: 1 });
    expect(fakes.chain.mined).toHaveLength(1);
    expect(fakes.chain.balanceOf(link.address)).toBe(parseEther("20"));
    expect(claimRows().map((row) => row.status)).toEqual(["paid", "rejected"]);
  });

  it.each([
    ["the response was lost", { kind: "accept_then_http" }],
    ["the provider answered with an error", { kind: "accept_then_rpc", message: "Internal error" }],
  ] as const)("still pays when the node accepted the transfer but %s", async (_, failure) => {
    const link = seedLink(fakes.postgrest);
    fakes.chain.failNextSend(failure);

    expect((await claimFor(link)).outcome).toBe("paid");
    expect(claimRows()).toEqual([expect.objectContaining({ status: "paid" })]);
  });

  it("fails the claim without logging the RPC URL when the chain is unreachable", async () => {
    const logs = captureErrorLogs();
    fakes.network.route(TEST_RPC_URL, unavailableRpc);

    expect(await claimFor(seedLink(fakes.postgrest))).toEqual({ outcome: "payout_failed" });
    expect(logs.some((line) => line.includes("nonce lookup failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TEST_RPC_URL);
  });

  it("records a failed attempt when no price is available", async () => {
    fakes.alchemy.status = 503;

    expect(await claimFor(seedLink(fakes.postgrest))).toEqual({ outcome: "payout_failed" });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "failed", usd_amount: "5", tx_hash: null })]);
    expect(fakes.chain.accepted).toHaveLength(0);
  });

  it("records a failed attempt when the price API answers with something other than JSON", async () => {
    fakes.alchemy.answersWithHtml = true;

    expect(await claimFor(seedLink(fakes.postgrest))).toEqual({ outcome: "payout_failed" });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "failed", tx_hash: null })]);
  });

  it("refuses to pay when the price would exceed the per-claim cap", async () => {
    fakes.alchemy.usdPrice = "0.01";

    expect(await claimFor(seedLink(fakes.postgrest))).toEqual({ outcome: "payout_failed" });
    expect(fakes.chain.accepted).toHaveLength(0);
  });

  it("marks the claim failed when the transfer reverts on chain", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.chain.revertTransfersTo(link.address);

    expect(await claimFor(link)).toEqual({ outcome: "payout_failed" });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("reports pending with the transaction when confirmation takes too long", async () => {
    fakes.chain.autoMine = false;
    const link = seedLink(fakes.postgrest);

    const outcome = await claimFor(link);

    expect(outcome).toMatchObject({ outcome: "pending", txHash: fakes.chain.accepted[0]?.hash });
    expect(claimRows()).toEqual([expect.objectContaining({ status: "pending", tx_hash: fakes.chain.accepted[0]?.hash })]);
    expect(await ledgerRows()).toEqual([expect.objectContaining({ state: "sent" })]);
  });

  it("reports paid when the transfer mined but recording it failed", async () => {
    const link = seedLink(fakes.postgrest);
    fakes.postgrest.failNext("PATCH", "claims_history");

    expect((await claimFor(link)).outcome).toBe("paid");
    expect(claimRows()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await ledgerRows()).toEqual([expect.objectContaining({ state: "confirmed", recorded: 0 })]);
  });
});

describe("claim: concurrency", () => {
  it("pays exactly the open spots when more wallets claim at the same moment", async () => {
    const links = Array.from({ length: TEST_DAILY_LIMIT + 3 }, () => seedLink(fakes.postgrest));

    const outcomes = await Promise.all(links.map(claimFor));

    expect(outcomes.filter((o) => o.outcome === "paid")).toHaveLength(TEST_DAILY_LIMIT);
    expect(outcomes.filter((o) => o.outcome === "rejected" && o.reason === "no_spots")).toHaveLength(3);
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0, 1, 2, 3]);
  });

  it("pays a wallet only once when it claims several times at the same moment", async () => {
    const link = seedLink(fakes.postgrest);

    const outcomes = await Promise.all([claimFor(link), claimFor(link), claimFor(link)]);

    expect(outcomes.filter((o) => o.outcome === "paid")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "rejected" && o.reason === "wallet_claimed")).toHaveLength(2);
    expect(fakes.chain.mined).toHaveLength(1);
  });

  it("reuses the nonce of a reservation the worker crashed on instead of queueing behind it", async () => {
    await writeCrashedReservation(crypto.randomUUID(), randomAddress().toLowerCase() as Hex, 0);

    expect((await claimFor(seedLink(fakes.postgrest))).outcome).toBe("paid");
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0]);
    expect((await ledgerRows()).map((row) => [row.state, row.nonce]).sort()).toEqual([
      ["abandoned", 0],
      ["confirmed", 0],
    ]);
  });

  it("does not reuse a nonce the worker already saw mined when the node reports a stale count", async () => {
    await claimFor(seedLink(fakes.postgrest));
    fakes.chain.transactionCountLag = 1;

    expect((await claimFor(seedLink(fakes.postgrest))).outcome).toBe("paid");
    expect(fakes.chain.mined.map((tx) => tx.nonce)).toEqual([0, 1]);
  });

  it("gives queued transfers consecutive nonces while earlier ones are unconfirmed", async () => {
    fakes.chain.autoMine = false;
    const links = [seedLink(fakes.postgrest), seedLink(fakes.postgrest), seedLink(fakes.postgrest)];

    const outcomes = await Promise.all(links.map(claimFor));

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["pending", "pending", "pending"]);
    expect(fakes.chain.pendingTransactions().map((tx) => tx.nonce).sort()).toEqual([0, 1, 2]);
  });
});
