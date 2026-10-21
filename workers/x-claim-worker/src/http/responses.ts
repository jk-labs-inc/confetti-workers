import type { ErrorCode } from "./types";

export const NO_STORE = { "Cache-Control": "no-store" };

export const jsonResponse = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export const errorResponse = (error: ErrorCode, message: string, status: number): Response =>
  jsonResponse({ error, message }, status);

export const redirectResponse = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: location, ...NO_STORE },
  });

export const returnUrl = (
  origin: string,
  returnPath: string,
  params: Record<string, string | undefined>,
): string => {
  const url = new URL(returnPath, origin);
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
};
