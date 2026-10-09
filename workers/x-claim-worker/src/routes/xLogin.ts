import { coordinatorStub } from "../claims/claimCoordinator";
import { isAllowedOrigin } from "../http/cors";
import { parseReturnPath, readJsonObject } from "../http/requests";
import { errorResponse, jsonResponse, redirectResponse, returnUrl } from "../http/responses";
import type { RouteContext } from "../http/types";
import {
  browserBindingCookie,
  browserBindingFrom,
  isSameBrowser,
  saveLoginState,
  takeLoginState,
} from "../linking/loginState";
import { linkXAccount } from "../linking/xAccountLink";
import { insertClaim } from "../supabase/claimsHistory";
import { verifyWalletProof } from "../walletProof/verify";
import { authorizeUrl, exchangeCode, pkceChallenge, randomUrlToken, revokeToken } from "../x/oauth";
import { fetchMe } from "../x/profile";
import type { XProfile } from "../x/types";
import { CLAIM_OUTCOME_PARAM, outcomeParams, type OutcomeParams } from "./claimOutcome";

const redirectToAppHome = ({ request, settings }: RouteContext, outcome: string) =>
  redirectResponse(
    returnUrl(settings.allowedOrigins[0] ?? new URL(request.url).origin, "/", { [CLAIM_OUTCOME_PARAM]: outcome }),
  );

export const handleXStart = async (context: RouteContext) => {
  const { request, env, settings } = context;
  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin, settings.allowedOrigins))
    return errorResponse("origin_not_allowed", "An allowed Origin header is required", 403);

  const body = await readJsonObject(request);
  const returnPath = parseReturnPath(body?.returnPath);
  if (!returnPath)
    return errorResponse("invalid_request", "returnPath must be a path starting with /", 400);

  const address = await verifyWalletProof(request, env, settings);

  const state = randomUrlToken();
  const codeVerifier = randomUrlToken();
  const browserBinding = browserBindingFrom(request) ?? randomUrlToken();
  await saveLoginState(env, state, { address, codeVerifier, origin, returnPath, browserBinding });

  return jsonResponse(
    { authorizeUrl: authorizeUrl(settings, state, await pkceChallenge(codeVerifier)) },
    200,
    { "Set-Cookie": browserBindingCookie(browserBinding) },
  );
};

const fetchProfileOnce = async (
  { ctx, settings }: RouteContext,
  code: string,
  codeVerifier: string,
): Promise<XProfile> => {
  const accessToken = await exchangeCode(settings, code, codeVerifier);
  try {
    return await fetchMe(accessToken);
  } finally {
    ctx.waitUntil(
      revokeToken(settings, accessToken).catch((error) => console.warn("X token revoke failed", error)),
    );
  }
};

const completeXLogin = async (context: RouteContext) => {
  const { request, env, settings } = context;
  const url = new URL(request.url);
  const loginState = await takeLoginState(env, url.searchParams.get("state"));
  if (!loginState) return redirectToAppHome(context, "x_state_invalid");

  const redirectBack = (params: OutcomeParams) =>
    redirectResponse(returnUrl(loginState.origin, loginState.returnPath, params));

  if (!isSameBrowser(loginState, request)) {
    console.warn("X callback arrived in a browser that did not start the login");
    return redirectBack({ [CLAIM_OUTCOME_PARAM]: "x_browser_mismatch" });
  }

  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error"))
    return redirectBack({ [CLAIM_OUTCOME_PARAM]: "x_denied" });

  let profile: XProfile;
  try {
    profile = await fetchProfileOnce(context, code, loginState.codeVerifier);
  } catch (error) {
    console.error("X login failed", error);
    return redirectBack({ [CLAIM_OUTCOME_PARAM]: "x_error" });
  }

  try {
    const link = await linkXAccount(settings.supabase, loginState.address, profile);
    if (link.kind === "linked_elsewhere") {
      await insertClaim(settings.supabase, {
        address: loginState.address,
        platform_user_id: profile.id,
        status: "rejected",
        reject_reason: "x_linked_elsewhere",
      });
      return redirectBack(outcomeParams({ outcome: "rejected", reason: "x_linked_elsewhere" }));
    }
    return redirectBack(outcomeParams(await coordinatorStub(env).claim(link.link)));
  } catch (error) {
    console.error("linking or claiming failed", error);
    return redirectBack({ [CLAIM_OUTCOME_PARAM]: "server_error" });
  }
};

export const handleXCallback = (context: RouteContext) =>
  completeXLogin(context).catch((error) => {
    console.error("X callback failed", error);
    return redirectToAppHome(context, "server_error");
  });
