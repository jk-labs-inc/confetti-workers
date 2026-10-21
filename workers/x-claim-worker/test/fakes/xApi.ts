import { base64url } from "jose";
import { TEST_X_CLIENT_ID, TEST_X_CLIENT_SECRET } from "../support/bindings";

export const X_API_ORIGIN = "https://api.x.com";

export type XUserFixture = Record<string, unknown> & { id: string; username: string };

interface IssuedCode {
  challenge: string;
  redirectUri: string;
  user: XUserFixture;
}

const REQUIRED_USER_FIELDS = [
  "verified",
  "verified_type",
  "is_identity_verified",
  "subscription_type",
  "verified_followers_count",
  "public_metrics",
  "created_at",
];

const s256 = async (verifier: string) =>
  base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const readForm = async (request: Request) => new URLSearchParams(await request.text());

const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

export const xUser = (overrides: Partial<XUserFixture> = {}): XUserFixture => {
  const id = overrides.id ?? String(Math.floor(Math.random() * 1e15));
  return {
    id,
    username: `user${id}`,
    name: "Test User",
    verified: true,
    verified_type: "blue",
    is_identity_verified: false,
    subscription_type: "Premium",
    verified_followers_count: 3,
    created_at: "2015-03-01T12:00:00.000Z",
    public_metrics: { followers_count: 400, following_count: 300, post_count: 1200, listed_count: 2 },
    ...overrides,
  };
};

export class FakeX {
  meStatus = 200;
  readonly revokedTokens: string[] = [];
  private readonly codes = new Map<string, IssuedCode>();
  private readonly users = new Map<string, XUserFixture>();

  approve(authorizeUrl: string, user: XUserFixture): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== "https://x.com/i/oauth2/authorize")
      throw new Error(`Unexpected authorize URL ${authorizeUrl}`);
    if (url.searchParams.get("client_id") !== TEST_X_CLIENT_ID) throw new Error("Wrong client_id");
    if (url.searchParams.get("response_type") !== "code") throw new Error("Wrong response_type");
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE must use S256");
    if (url.searchParams.get("scope") !== "users.read tweet.read") throw new Error("Wrong scopes");

    const code = crypto.randomUUID();
    this.codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      user,
    });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /2/oauth2/token":
        return this.token(request);
      case "GET /2/users/me":
        return this.me(request, url);
      case "POST /2/oauth2/revoke":
        return this.revoke(request);
      default:
        return new Response("not found", { status: 404 });
    }
  };

  private hasClientCredentials(request: Request): boolean {
    return request.headers.get("Authorization") === `Basic ${btoa(`${TEST_X_CLIENT_ID}:${TEST_X_CLIENT_SECRET}`)}`;
  }

  private async token(request: Request): Promise<Response> {
    if (!this.hasClientCredentials(request)) return oauthError("invalid_client", 401);

    const form = await readForm(request);
    const issued = this.codes.get(form.get("code") ?? "");
    if (!issued || form.get("grant_type") !== "authorization_code") return oauthError("invalid_grant");
    this.codes.delete(form.get("code") ?? "");
    if (form.get("redirect_uri") !== issued.redirectUri) return oauthError("invalid_request");
    if ((await s256(form.get("code_verifier") ?? "")) !== issued.challenge) return oauthError("invalid_grant");

    const accessToken = crypto.randomUUID();
    this.users.set(accessToken, issued.user);
    return Response.json({
      token_type: "bearer",
      expires_in: 7200,
      access_token: accessToken,
      scope: "users.read tweet.read",
    });
  }

  private me(request: Request, url: URL): Response {
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const user = this.users.get(token);
    if (!user || this.revokedTokens.includes(token))
      return Response.json({ title: "Unauthorized", status: 401, detail: "Unauthorized" }, { status: 401 });
    if (this.meStatus !== 200)
      return Response.json({ title: "Service Unavailable", status: this.meStatus }, { status: this.meStatus });

    const fields = (url.searchParams.get("user.fields") ?? "").split(",");
    const missing = REQUIRED_USER_FIELDS.filter((field) => !fields.includes(field));
    if (missing.length) throw new Error(`users/me called without ${missing.join(", ")}`);
    return Response.json({ data: user });
  }

  private async revoke(request: Request): Promise<Response> {
    if (!this.hasClientCredentials(request)) return oauthError("invalid_client", 401);
    const token = (await readForm(request)).get("token") ?? "";
    this.revokedTokens.push(token);
    return Response.json({ revoked: true });
  }
}
