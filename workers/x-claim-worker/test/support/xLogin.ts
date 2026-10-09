import { expect } from "vitest";
import type { FakeX, XUserFixture } from "../fakes/xApi";
import { callWorker, proofPost } from "./harness";
import { paraProof } from "./proofs";

export interface LoginStart {
  authorizeUrl: string;
  cookie: string;
}

export const startLogin = (proof: string, returnPath: unknown = "/contest/1", cookie?: string) =>
  callWorker("/x/start", proofPost(proof, { returnPath }, cookie ? { Cookie: cookie } : {}));

export const authorizeUrlFrom = async (response: Response): Promise<string> => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { authorizeUrl: string }).authorizeUrl;
};

export const browserCookieFrom = (response: Response): string =>
  (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

export const beginLogin = async (proof: string, returnPath?: string, cookie?: string): Promise<LoginStart> => {
  const response = await startLogin(proof, returnPath, cookie);
  return { authorizeUrl: await authorizeUrlFrom(response), cookie: browserCookieFrom(response) };
};

export const callback = (query: Record<string, string>, headers: Record<string, string> = {}) =>
  callWorker(`/x/callback?${new URLSearchParams(query)}`, { origin: null, headers, redirect: "manual" });

export const finishLogin = (
  x: FakeX,
  { authorizeUrl, cookie }: LoginStart,
  user: XUserFixture,
  headers: Record<string, string> = {},
) => callback(x.approve(authorizeUrl, user), { Cookie: cookie, ...headers });

export const redirectOf = (response: Response): URL => {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "");
};

export const linkWithX = async (x: FakeX, address: string, user: XUserFixture, returnPath = "/contest/1") =>
  redirectOf(await finishLogin(x, await beginLogin(await paraProof(address), returnPath), user));
