import { coordinatorStub } from "./claims/claimCoordinator";
import { readSettings } from "./config/settings";
import type { Settings } from "./config/types";
import { corsHeadersFor, isAllowedOrigin, preflightResponse } from "./http/cors";
import { errorResponse } from "./http/responses";
import type { CorsHeaders, Route, RouteContext } from "./http/types";
import { handleClaim, handleClaimMe } from "./routes/claim";
import { handleNonce } from "./routes/nonce";
import { handleSpots } from "./routes/spots";
import { handleXCallback, handleXStart } from "./routes/xLogin";
import { SupabaseError } from "./supabase/client";
import { ProofUnavailableError, WalletProofError } from "./walletProof/errors";

export { ClaimCoordinator } from "./claims/claimCoordinator";
export { OneTimeStore } from "./oneTimeStore/oneTimeStore";

const ROUTES: Record<string, Partial<Record<string, Route>>> = {
  "/spots": { GET: { handler: handleSpots } },
  "/nonce": { POST: { handler: handleNonce } },
  "/x/start": { POST: { handler: handleXStart, credentialed: true } },
  "/x/callback": { GET: { handler: handleXCallback, browserNavigation: true } },
  "/claim/me": { GET: { handler: handleClaimMe } },
  "/claim": { POST: { handler: handleClaim } },
};

const routeFor = (pathname: string, method: string | null): Route | undefined => {
  const methods = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  return methods && method !== null && Object.hasOwn(methods, method) ? methods[method] : undefined;
};

const errorResponseFor = (error: unknown): Response => {
  if (error instanceof WalletProofError) return errorResponse("invalid_proof", error.message, 401);
  if (error instanceof ProofUnavailableError)
    return errorResponse("proof_unavailable", error.message, 503);
  console.error("request failed", error);
  if (error instanceof SupabaseError)
    return errorResponse("storage_unavailable", "Storage is unavailable", 503);
  return errorResponse("internal_error", "Something went wrong", 500);
};

const withHeaders = (response: Response, headers: CorsHeaders): Response => {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
};

const runRoute = async (
  route: Route,
  context: RouteContext,
  corsHeaders: CorsHeaders,
): Promise<Response> =>
  withHeaders(await route.handler(context).catch(errorResponseFor), corsHeaders);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let settings: Settings;
    try {
      settings = readSettings(env);
    } catch (error) {
      console.error("invalid worker settings", error);
      return errorResponse("server_misconfigured", "Server configuration error", 500);
    }

    const { pathname } = new URL(request.url);
    const route = routeFor(pathname, request.method);
    if (route?.browserNavigation) return runRoute(route, { request, env, ctx, settings }, {});

    if (request.method === "OPTIONS") {
      const requestedRoute = routeFor(pathname, request.headers.get("Access-Control-Request-Method"));
      return preflightResponse(request, settings.allowedOrigins, requestedRoute?.credentialed === true);
    }

    const origin = request.headers.get("Origin");
    if (origin !== null && !isAllowedOrigin(origin, settings.allowedOrigins))
      return errorResponse("origin_not_allowed", "Origin not allowed", 403);

    const corsHeaders = corsHeadersFor(origin, settings.allowedOrigins, route?.credentialed === true);
    if (!route) return withHeaders(errorResponse("not_found", "Not found", 404), corsHeaders);

    return runRoute(route, { request, env, ctx, settings }, corsHeaders);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      coordinatorStub(env)
        .runMaintenance()
        .then((report) => console.log("maintenance", JSON.stringify(report)))
        .catch((error) => console.error("maintenance failed", error)),
    );
  },
} satisfies ExportedHandler<Env>;
