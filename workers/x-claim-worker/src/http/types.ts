import type { Settings } from "../config/types";

export type ErrorCode =
  | "invalid_request"
  | "origin_not_allowed"
  | "invalid_proof"
  | "proof_unavailable"
  | "not_linked"
  | "storage_unavailable"
  | "server_misconfigured"
  | "not_found"
  | "internal_error";

export type CorsHeaders = Record<string, string>;

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  settings: Settings;
}

type RouteHandler = (context: RouteContext) => Promise<Response>;

export interface Route {
  handler: RouteHandler;
  browserNavigation?: boolean;
  credentialed?: boolean;
}
