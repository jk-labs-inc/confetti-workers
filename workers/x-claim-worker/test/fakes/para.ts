import { importJWK, SignJWT, type JWK } from "jose";
import { TEST_PARA_AUDIENCE } from "../support/bindings";
import { TEST_PARA_KEY_ID, TEST_PARA_PRIVATE_JWK } from "./paraTestKey";

export const PARA_BETA_ORIGIN = "https://api.beta.getpara.com";
export const PARA_PROD_ORIGIN = "https://api.getpara.com";

export interface ParaWalletFixture {
  type: string;
  address: string;
}

const PUBLIC_JWK = {
  kty: TEST_PARA_PRIVATE_JWK.kty,
  n: TEST_PARA_PRIVATE_JWK.n,
  e: TEST_PARA_PRIVATE_JWK.e,
  kid: TEST_PARA_KEY_ID,
  alg: "RS256",
  use: "sig",
};

export class FakePara {
  jwksStatus = 200;

  handle = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/.well-known/jwks.json")
      return new Response("not found", { status: 404 });
    if (this.jwksStatus !== 200) return new Response("unavailable", { status: this.jwksStatus });
    return Response.json({ keys: [PUBLIC_JWK] });
  };
}

export const mintParaJwt = async ({
  wallets,
  audience = TEST_PARA_AUDIENCE,
  expiresAt = Math.floor(Date.now() / 1000) + 1800,
  signingKey = TEST_PARA_PRIVATE_JWK,
}: {
  wallets: ParaWalletFixture[];
  audience?: string;
  expiresAt?: number;
  signingKey?: JWK;
}): Promise<string> => {
  const userId = crypto.randomUUID();
  const key = await importJWK({ ...signingKey, alg: "RS256" }, "RS256");
  return new SignJWT({ data: { userId, wallets, authType: "email", identifier: "user@example.com" } })
    .setProtectedHeader({ alg: "RS256", kid: TEST_PARA_KEY_ID })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setAudience(audience)
    .setSubject(userId)
    .sign(key);
};
