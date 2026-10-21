import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Settings } from "../config/types";
import { ProofUnavailableError, WalletProofError } from "./errors";
import type { ParaProof, ParaWalletClaim } from "./types";

const PARA_JWT_ALGORITHMS = ["RS256"];
const PARA_EVM_WALLET_TYPE = "EVM";
const PARA_KEYS_UNAVAILABLE_CODES = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"]);

const paraKeySets = new Map<string, JWTVerifyGetKey>();

const paraKeySet = (jwksUrl: string): JWTVerifyGetKey => {
  let keySet = paraKeySets.get(jwksUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUrl));
    paraKeySets.set(jwksUrl, keySet);
  }
  return keySet;
};

const verifiedPayload = async (
  jwt: string,
  settings: Settings,
): Promise<Record<string, unknown>> => {
  try {
    const { payload } = await jwtVerify(jwt, paraKeySet(settings.paraJwksUrl), {
      algorithms: PARA_JWT_ALGORITHMS,
      audience: settings.paraJwtAudience,
      requiredClaims: ["exp"],
    });
    return payload;
  } catch (error) {
    if (error instanceof errors.JOSEError && !PARA_KEYS_UNAVAILABLE_CODES.has(error.code))
      throw new WalletProofError("Para session token is invalid or expired");
    console.error("Para key set unavailable", error);
    throw new ProofUnavailableError("Could not load Para signing keys");
  }
};

const evmWallets = (payload: Record<string, unknown>): ParaWalletClaim[] => {
  const wallets = (payload.data as { wallets?: unknown } | undefined)?.wallets;
  if (!Array.isArray(wallets)) return [];
  return (wallets as ParaWalletClaim[]).filter((wallet) => wallet.type === PARA_EVM_WALLET_TYPE);
};

export const verifyParaProof = async (proof: ParaProof, settings: Settings): Promise<string> => {
  const payload = await verifiedPayload(proof.jwt, settings);
  const address = proof.address.toLowerCase();
  const ownsAddress = evmWallets(payload).some(
    (wallet) => typeof wallet.address === "string" && wallet.address.toLowerCase() === address,
  );
  if (!ownsAddress)
    throw new WalletProofError("Para session token does not include this wallet");
  return address;
};
