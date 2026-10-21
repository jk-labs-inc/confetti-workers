import { base64url } from "jose";
import type { Settings } from "../config/types";
import { X_AUTHORIZE_URL, X_REVOKE_URL, X_SCOPES, X_TOKEN_URL } from "./constants";
import { XApiError } from "./errors";

const RANDOM_TOKEN_BYTES = 32;

export const randomUrlToken = (): string =>
  base64url.encode(crypto.getRandomValues(new Uint8Array(RANDOM_TOKEN_BYTES)));

export const pkceChallenge = async (verifier: string): Promise<string> =>
  base64url.encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

export const authorizeUrl = (
  settings: Settings,
  state: string,
  codeChallenge: string,
): string => {
  const url = new URL(X_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: settings.xClientId,
    redirect_uri: settings.xRedirectUri,
    scope: X_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

const basicAuthorization = (settings: Settings): string =>
  `Basic ${btoa(`${settings.xClientId}:${settings.xClientSecret}`)}`;

const postForm = (settings: Settings, url: string, form: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(settings),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });

export const exchangeCode = async (
  settings: Settings,
  code: string,
  codeVerifier: string,
): Promise<string> => {
  const response = await postForm(settings, X_TOKEN_URL, {
    code,
    grant_type: "authorization_code",
    redirect_uri: settings.xRedirectUri,
    code_verifier: codeVerifier,
  });
  if (!response.ok)
    throw new XApiError(`X token exchange failed with ${response.status}`);

  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string")
    throw new XApiError("X token response has no access_token");
  return body.access_token;
};

export const revokeToken = async (settings: Settings, accessToken: string): Promise<void> => {
  const response = await postForm(settings, X_REVOKE_URL, {
    token: accessToken,
    token_type_hint: "access_token",
  });
  if (!response.ok) console.warn("X token revoke failed", response.status);
};
