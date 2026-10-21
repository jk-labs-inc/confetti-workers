import { WALLET_PROOF_HEADER } from "../walletProof/constants";
import type { CorsHeaders } from "./types";

const CORS_MAX_AGE_SECONDS = "86400";

export const isAllowedOrigin = (
  origin: string | null,
  allowedOrigins: string[],
): origin is string => origin !== null && allowedOrigins.includes(origin);

export const corsHeadersFor = (
  origin: string | null,
  allowedOrigins: string[],
  allowCredentials = false,
): CorsHeaders => {
  if (!isAllowedOrigin(origin, allowedOrigins)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${WALLET_PROOF_HEADER}`,
    "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
    ...(allowCredentials ? { "Access-Control-Allow-Credentials": "true" } : {}),
    Vary: "Origin",
  };
};

export const preflightResponse = (
  request: Request,
  allowedOrigins: string[],
  allowCredentials: boolean,
): Response => {
  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin, allowedOrigins)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: corsHeadersFor(origin, allowedOrigins, allowCredentials),
  });
};
