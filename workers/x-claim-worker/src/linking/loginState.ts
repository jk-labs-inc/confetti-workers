import { oneTimeStub } from "../oneTimeStore/oneTimeStore";
import type { XLoginState } from "./types";

const X_LOGIN_STATE_TTL_SECONDS = 600;
const BROWSER_BINDING_COOKIE = "__Host-x_claim_browser";

const URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const X_LOGIN_STATE_FIELDS = ["address", "codeVerifier", "origin", "returnPath", "browserBinding"] as const;

const isXLoginState = (value: unknown): value is XLoginState => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return X_LOGIN_STATE_FIELDS.every((field) => typeof record[field] === "string");
};

export const saveLoginState = (env: Env, state: string, loginState: XLoginState) =>
  oneTimeStub(env, "xstate", state).put(loginState, X_LOGIN_STATE_TTL_SECONDS);

export const takeLoginState = async (
  env: Env,
  state: string | null,
): Promise<XLoginState | null> => {
  if (!state || !URL_TOKEN_PATTERN.test(state)) return null;
  const stored = await oneTimeStub(env, "xstate", state).take();
  return isXLoginState(stored) ? stored : null;
};

export const browserBindingFrom = (request: Request): string | null => {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (pair.slice(0, separator).trim() !== BROWSER_BINDING_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return URL_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
};

export const browserBindingCookie = (browserBinding: string): string =>
  `${BROWSER_BINDING_COOKIE}=${browserBinding}; Max-Age=${X_LOGIN_STATE_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;

export const isSameBrowser = (loginState: XLoginState, request: Request): boolean => {
  const presented = browserBindingFrom(request);
  if (!presented) return false;
  const encoder = new TextEncoder();
  const expected = encoder.encode(loginState.browserBinding);
  const actual = encoder.encode(presented);
  return expected.byteLength === actual.byteLength && crypto.subtle.timingSafeEqual(expected, actual);
};
