import {
  abortAllDurableObjects,
  createExecutionContext,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { coordinatorStub } from "../../src/claims/claimCoordinator";
import worker from "../../src/index";
import { WALLET_PROOF_HEADER } from "../../src/walletProof/constants";
import { TEST_APP_ORIGIN, TEST_WORKER_ORIGIN } from "./bindings";

type FakeHandler = (request: Request) => Response | Promise<Response>;

type WorkerRequestInit = RequestInit & { origin?: string | null };

export type EnvOverrides = Partial<Record<keyof Env, unknown>>;

export const envWith = (overrides: EnvOverrides): Env => ({ ...env, ...overrides }) as Env;

export class FakeNetwork {
  private readonly handlers = new Map<string, FakeHandler>();
  readonly requests: URL[] = [];

  route(origin: string, handler: FakeHandler): void {
    this.handlers.set(new URL(origin).origin, handler);
  }

  requestsTo(origin: string): URL[] {
    const expected = new URL(origin).origin;
    return this.requests.filter((url) => url.origin === expected);
  }

  async dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(url);
    const handler = this.handlers.get(url.origin);
    if (!handler) throw new Error(`Unexpected outbound fetch to ${url.href}`);
    return handler(request);
  }
}

const loggedText = (value: unknown): string => {
  if (!(value instanceof Error)) return typeof value === "string" ? value : String(value);
  return [value.message, value.stack ?? "", value.cause === undefined ? "" : loggedText(value.cause)].join("\n");
};

export const captureErrorLogs = (): string[] => {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(loggedText).join(" "));
  });
  return logs;
};

export const useFakeNetwork = (setup: (network: FakeNetwork) => void): FakeNetwork => {
  const network = new FakeNetwork();

  beforeEach(() => {
    network.requests.length = 0;
    setup(network);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      network.dispatch(input, init),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runInDurableObject(coordinatorStub(env), (_, state) => state.storage.deleteAll());
    await abortAllDurableObjects();
    await reset();
  });

  return network;
};

const workerRequest = (path: string, init: WorkerRequestInit = {}): Request => {
  const { origin = TEST_APP_ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`${TEST_WORKER_ORIGIN}${path}`, { ...rest, headers });
};

export const proofPost = (
  proof: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", [WALLET_PROOF_HEADER]: proof, ...headers },
  body: JSON.stringify(body),
});

export const callWorker = (path: string, init: WorkerRequestInit = {}): Promise<Response> =>
  exports.default.fetch(workerRequest(path, init));

export const callWorkerWithEnv = async (
  overrides: EnvOverrides,
  path: string,
  init: WorkerRequestInit = {},
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    workerRequest(path, init) as Request<unknown, IncomingRequestCfProperties>,
    envWith(overrides),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};
