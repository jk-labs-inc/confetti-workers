import type { SupabaseConfig, SupabaseMethod, SupabaseRequestOptions, SupabaseResponse } from "./types";

const UNIQUE_VIOLATION_CODE = "23505";
const LEGACY_JWT_KEY_PREFIX = "eyJ";
const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;

export const RETURN_REPRESENTATION: SupabaseRequestOptions = { prefer: ["return=representation"] };

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly postgresCode?: string,
  ) {
    super(message);
  }

  get isUniqueViolation(): boolean {
    return this.postgresCode === UNIQUE_VIOLATION_CODE;
  }
}

const authHeaders = (config: SupabaseConfig): Record<string, string> =>
  config.serviceRoleKey.startsWith(LEGACY_JWT_KEY_PREFIX)
    ? { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` }
    : { apikey: config.serviceRoleKey };

const errorFrom = (status: number, text: string): SupabaseError => {
  let postgresCode: string | undefined;
  let message = `Supabase request failed with ${status}`;
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") postgresCode = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {}
  return new SupabaseError(message, postgresCode);
};

const parseBody = (text: string): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SupabaseError("Supabase answered with invalid JSON");
  }
};

const send = async (url: string, init: RequestInit): Promise<{ response: Response; text: string }> => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS) });
    return { response, text: await response.text() };
  } catch (error) {
    throw new SupabaseError(`Supabase request did not complete: ${String(error)}`);
  }
};

export const supabaseRequest = async (
  config: SupabaseConfig,
  method: SupabaseMethod,
  table: string,
  query: URLSearchParams,
  options: SupabaseRequestOptions = {},
): Promise<SupabaseResponse> => {
  const headers: Record<string, string> = {
    ...authHeaders(config),
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.prefer?.length) headers.Prefer = options.prefer.join(",");

  const queryString = query.toString();
  const { response, text } = await send(`${config.url}/rest/v1/${table}${queryString ? `?${queryString}` : ""}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw errorFrom(response.status, text);
  return { headers: response.headers, body: parseBody(text) };
};

export const allRows = <T>(response: SupabaseResponse): T[] => {
  if (!Array.isArray(response.body)) throw new SupabaseError("Expected rows back");
  return response.body as T[];
};

const firstRow = <T>(response: SupabaseResponse): T | null => allRows<T>(response)[0] ?? null;

export const selectFirst = async <T>(
  config: SupabaseConfig,
  table: string,
  filter: Record<string, string>,
): Promise<T | null> =>
  firstRow<T>(
    await supabaseRequest(config, "GET", table, new URLSearchParams({ select: "*", ...filter, limit: "1" })),
  );

export const onlyRow = <T>(response: SupabaseResponse): T => {
  const row = firstRow<T>(response);
  if (!row) throw new SupabaseError("Expected one row back");
  return row;
};

export const exactCount = (response: SupabaseResponse): number => {
  const total = response.headers.get("Content-Range")?.split("/")[1];
  const count = total === undefined ? Number.NaN : Number(total);
  if (!Number.isInteger(count)) throw new SupabaseError("Missing exact count");
  return count;
};
