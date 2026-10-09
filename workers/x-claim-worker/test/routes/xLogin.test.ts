import { env } from "cloudflare:workers";
import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { oneTimeStub } from "../../src/oneTimeStore/oneTimeStore";
import { issueWalletNonce } from "../../src/walletProof/siwe";
import { X_API_ORIGIN, xUser, type XUserFixture } from "../fakes/xApi";
import { TEST_APP_ORIGIN, TEST_WORKER_ORIGIN } from "../support/bindings";
import { fillTodaysSpots, useClaimNetwork } from "../support/claimNetwork";
import { callWorker, callWorkerWithEnv } from "../support/harness";
import { paraProof, randomAccount, randomAddress, siweProof } from "../support/proofs";
import {
  authorizeUrlFrom,
  beginLogin,
  callback,
  finishLogin,
  linkWithX as linkWithFakeX,
  redirectOf,
  startLogin,
} from "../support/xLogin";

const fakes = useClaimNetwork();

const linkWithX = (address: string, user: XUserFixture, returnPath?: string) =>
  linkWithFakeX(fakes.x, address, user, returnPath);

describe("POST /x/start", () => {
  it("returns X's authorization URL with PKCE and the worker's callback", async () => {
    const url = new URL(await authorizeUrlFrom(await startLogin(await paraProof(randomAddress()))));

    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      redirect_uri: `${TEST_WORKER_ORIGIN}/x/callback`,
      scope: "users.read tweet.read",
      code_challenge_method: "S256",
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it.each(["//evil.test/x", "https://evil.test/", "contest/1", "/\\evil.test", "", 42])(
    "rejects the return path %j",
    async (returnPath) => {
      const response = await startLogin(await paraProof(randomAddress()), returnPath);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    },
  );

  it("requires an allowed Origin header", async () => {
    const response = await callWorker("/x/start", {
      method: "POST",
      origin: null,
      headers: { "X-Wallet-Proof": await paraProof(randomAddress()) },
      body: JSON.stringify({ returnPath: "/" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects a request without a valid wallet proof", async () => {
    const response = await startLogin("not-a-proof");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_proof" });
  });

  it("binds the login to this browser with a host-only HttpOnly cookie", async () => {
    const response = await startLogin(await paraProof(randomAddress()));

    expect(response.headers.get("Set-Cookie")).toMatch(
      /^__Host-x_claim_browser=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("allows credentials in the preflight for /x/start only", async () => {
    const preflight = (path: string) =>
      callWorker(path, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } });

    expect((await preflight("/x/start")).headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect((await preflight("/claim")).headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("GET /x/callback", () => {
  it("links the X account, pays the wallet, revokes the token and returns to the app", async () => {
    const address = randomAddress();
    const user = xUser({ verified_type: "business" });

    const redirect = await linkWithX(address, user);

    expect(redirect.origin + redirect.pathname).toBe(`${TEST_APP_ORIGIN}/contest/1`);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({
      x_claim: "paid",
      tx: fakes.chain.mined[0]?.hash,
      amount: "20",
      currency: "POL",
      network: "polygon",
    });
    expect(fakes.chain.balanceOf(address)).toBe(parseEther("20"));
    expect(fakes.postgrest.rows("social_links")).toEqual([
      expect.objectContaining({
        address: address.toLowerCase(),
        platform: "x",
        platform_user_id: user.id,
        handle: user.username,
        verified: true,
        verified_type: "business",
        verified_followers_count: 3,
        followers_count: 400,
        following_count: 300,
        post_count: 1200,
        account_created_at: "2015-03-01T12:00:00.000Z",
      }),
    ]);
    expect(fakes.x.revokedTokens).toHaveLength(1);
  });

  it("links an external wallet proven with a signed message", async () => {
    const account = randomAccount();
    const { nonce } = await issueWalletNonce(env);
    const login = await beginLogin(await siweProof(account, nonce));

    const redirect = redirectOf(await finishLogin(fakes.x, login, xUser()));

    expect(redirect.searchParams.get("x_claim")).toBe("paid");
    expect(fakes.postgrest.rows("social_links")[0]?.address).toBe(account.address.toLowerCase());
  });

  it("keeps the return path's query and fragment", async () => {
    const redirect = await linkWithX(randomAddress(), xUser(), "/contest/1?tab=vote#top");

    expect(redirect.pathname).toBe("/contest/1");
    expect(redirect.searchParams.get("tab")).toBe("vote");
    expect(redirect.searchParams.get("x_claim")).toBe("paid");
    expect(redirect.hash).toBe("#top");
  });

  it("refreshes the numbers when the same wallet links the same account again", async () => {
    const address = randomAddress();
    const user = xUser();
    await linkWithX(address, user);

    await linkWithX(address, { ...user, verified_followers_count: 9 });

    expect(fakes.postgrest.rows("social_links")).toHaveLength(1);
    expect(fakes.postgrest.rows("social_links")[0]?.verified_followers_count).toBe(9);
  });

  it("refuses an X account already linked to another wallet and records the attempt", async () => {
    const owner = randomAddress();
    const other = randomAddress();
    const user = xUser();
    await linkWithX(owner, user);

    const redirect = await linkWithX(other, { ...user, followers_count: 999 });

    expect(redirect.searchParams.get("x_claim")).toBe("x_linked_elsewhere");
    expect(fakes.postgrest.rows("social_links")).toEqual([
      expect.objectContaining({ address: owner.toLowerCase(), platform_user_id: user.id }),
    ]);
    expect(fakes.postgrest.rows("claims_history").filter((row) => row.status === "rejected")).toEqual([
      expect.objectContaining({
        address: other.toLowerCase(),
        platform_user_id: user.id,
        status: "rejected",
        reject_reason: "x_linked_elsewhere",
      }),
    ]);
  });

  it("gives one X account to only one of two wallets linking at the same moment", async () => {
    const user = xUser();
    const logins = await Promise.all(
      [randomAddress(), randomAddress()].map(async (address) => beginLogin(await paraProof(address))),
    );

    const outcomes = await Promise.all(
      logins.map(async (login) => redirectOf(await finishLogin(fakes.x, login, user)).searchParams.get("x_claim")),
    );

    expect(outcomes.sort()).toEqual(["paid", "x_linked_elsewhere"]);
    expect(fakes.postgrest.rows("social_links")).toHaveLength(1);
  });

  it("keeps the link but redirects with the failed check when the account is not eligible", async () => {
    const redirect = await linkWithX(randomAddress(), xUser({ verified_type: "none" }));

    expect(Object.fromEntries(redirect.searchParams)).toEqual({ x_claim: "not_verified" });
    expect(fakes.postgrest.rows("social_links")).toHaveLength(1);
    expect(fakes.chain.accepted).toHaveLength(0);
  });

  it("tells the app when spots open next", async () => {
    fillTodaysSpots(fakes.postgrest);

    const redirect = await linkWithX(randomAddress(), xUser());

    expect(redirect.searchParams.get("x_claim")).toBe("no_spots");
    expect(redirect.searchParams.get("next_release_at")).toMatch(/T00:00:00\.000Z$/);
  });

  it("reports a failed payout so the app can offer a retry", async () => {
    fakes.chain.failNextSend({ kind: "rpc", message: "insufficient funds for gas * price + value" });

    const redirect = await linkWithX(randomAddress(), xUser());

    expect(Object.fromEntries(redirect.searchParams)).toEqual({ x_claim: "payout_failed" });
  });

  it("accepts each state only once", async () => {
    const login = await beginLogin(await paraProof(randomAddress()));
    const approval = fakes.x.approve(login.authorizeUrl, xUser());
    await callback(approval, { Cookie: login.cookie });

    const replay = redirectOf(await callback(approval, { Cookie: login.cookie }));

    expect(replay.toString()).toBe(`${TEST_APP_ORIGIN}/?x_claim=x_state_invalid`);
  });

  it("rejects an expired state", async () => {
    const state = "a".repeat(43);
    await oneTimeStub(env, "xstate", state).put(
      { address: randomAddress(), codeVerifier: "v", origin: TEST_APP_ORIGIN, returnPath: "/", browserBinding: "b".repeat(43) },
      0,
    );

    const redirect = redirectOf(await callback({ state, code: "code" }, { Cookie: `__Host-x_claim_browser=${"b".repeat(43)}` }));

    expect(redirect.searchParams.get("x_claim")).toBe("x_state_invalid");
  });

  it("returns to the app with server_error when the state store fails", async () => {
    const unavailableStore = {
      getByName: () => {
        throw new Error("Durable Object is overloaded");
      },
    };

    const response = await callWorkerWithEnv(
      { ONE_TIME_STORE: unavailableStore },
      `/x/callback?${new URLSearchParams({ state: "s".repeat(43), code: "code" })}`,
      { origin: null, redirect: "manual" },
    );

    expect(redirectOf(response).toString()).toBe(`${TEST_APP_ORIGIN}/?x_claim=server_error`);
  });

  it("reports a denial on X", async () => {
    const login = await beginLogin(await paraProof(randomAddress()));
    const { state } = fakes.x.approve(login.authorizeUrl, xUser());

    const redirect = redirectOf(await callback({ state, error: "access_denied" }, { Cookie: login.cookie }));

    expect(redirect.toString()).toBe(`${TEST_APP_ORIGIN}/contest/1?x_claim=x_denied`);
    expect(fakes.postgrest.rows("social_links")).toHaveLength(0);
  });

  it("fails the exchange when the PKCE verifier does not match the challenge", async () => {
    const login = await beginLogin(await paraProof(randomAddress()));
    const authorizeUrl = new URL(login.authorizeUrl);
    authorizeUrl.searchParams.set("code_challenge", "b".repeat(43));

    const redirect = redirectOf(await finishLogin(fakes.x, { ...login, authorizeUrl: authorizeUrl.toString() }, xUser()));

    expect(redirect.searchParams.get("x_claim")).toBe("x_error");
    expect(fakes.postgrest.rows("social_links")).toHaveLength(0);
  });

  it("reports X being unavailable and still revokes the token", async () => {
    fakes.x.meStatus = 503;

    const redirect = await linkWithX(randomAddress(), xUser());

    expect(redirect.searchParams.get("x_claim")).toBe("x_error");
    expect(fakes.x.revokedTokens).toHaveLength(1);
  });

  it("accepts the redirect even when the browser sends X's origin", async () => {
    const login = await beginLogin(await paraProof(randomAddress()));

    const response = await finishLogin(fakes.x, login, xUser(), { Origin: "https://x.com" });

    expect(redirectOf(response).searchParams.get("x_claim")).toBe("paid");
  });
});

describe("GET /x/callback: browser binding", () => {
  it("refuses an approval that comes back in a browser that did not start the login", async () => {
    const attackerLogin = await beginLogin(await paraProof(randomAddress()));
    const victimApproval = fakes.x.approve(attackerLogin.authorizeUrl, xUser());

    const redirect = redirectOf(await callback(victimApproval));

    expect(redirect.toString()).toBe(`${TEST_APP_ORIGIN}/contest/1?x_claim=x_browser_mismatch`);
    expect(fakes.network.requestsTo(X_API_ORIGIN)).toHaveLength(0);
    expect(fakes.postgrest.rows("social_links")).toHaveLength(0);
    expect(fakes.chain.accepted).toHaveLength(0);
    const replay = redirectOf(await callback(victimApproval, { Cookie: attackerLogin.cookie }));
    expect(replay.searchParams.get("x_claim")).toBe("x_state_invalid");
  });

  it("refuses an approval that comes back with another login's cookie", async () => {
    const attackerLogin = await beginLogin(await paraProof(randomAddress()));
    const victimLogin = await beginLogin(await paraProof(randomAddress()));

    const redirect = redirectOf(await finishLogin(fakes.x, { ...attackerLogin, cookie: victimLogin.cookie }, xUser()));

    expect(redirect.searchParams.get("x_claim")).toBe("x_browser_mismatch");
    expect(fakes.postgrest.rows("social_links")).toHaveLength(0);
  });

  it("keeps both logins working when one browser starts two", async () => {
    const first = await beginLogin(await paraProof(randomAddress()));
    const second = await beginLogin(await paraProof(randomAddress()), undefined, first.cookie);

    expect(second.cookie).toBe(first.cookie);
    for (const login of [first, second])
      expect(redirectOf(await finishLogin(fakes.x, login, xUser())).searchParams.get("x_claim")).toBe("paid");
  });
});
