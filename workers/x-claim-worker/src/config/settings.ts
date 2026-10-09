import type { Chain, Hex } from "viem";
import { polygon } from "viem/chains";
import { DECIMAL_PATTERN } from "../payout/amounts";
import type { PayoutSettings, Settings } from "./types";

export class SettingsError extends Error {}

type StringBinding = {
  [Name in keyof Env]-?: Env[Name] extends string | undefined ? Name : never;
}[keyof Env];

const PARA_JWKS_URLS: Record<string, string> = {
  BETA: "https://api.beta.getpara.com/.well-known/jwks.json",
  PROD: "https://api.getpara.com/.well-known/jwks.json",
};

const PAYOUT_CHAINS: Record<string, { chain: Chain; networkName: string }> = {
  polygon: { chain: polygon, networkName: "polygon" },
};

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const optionalString = (env: Env, name: StringBinding): string | undefined =>
  env[name]?.trim() || undefined;

const requireString = (env: Env, name: StringBinding): string => {
  const value = optionalString(env, name);
  if (!value) throw new SettingsError(`${name} is not set`);
  return value;
};

const requireBoolean = (env: Env, name: StringBinding): boolean => {
  const normalized = requireString(env, name).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new SettingsError(`${name} must be "true" or "false"`);
};

const requireInteger = (env: Env, name: StringBinding, minimum: number): number => {
  const raw = requireString(env, name);
  if (!/^\d+$/.test(raw)) throw new SettingsError(`${name} must be an integer`);
  const parsed = Number(raw);
  if (parsed < minimum) throw new SettingsError(`${name} must be at least ${minimum}`);
  return parsed;
};

const requireDecimal = (env: Env, name: StringBinding): string => {
  const raw = requireString(env, name);
  if (!DECIMAL_PATTERN.test(raw) || Number(raw) <= 0)
    throw new SettingsError(`${name} must be a positive decimal`);
  return raw;
};

const requireList = (env: Env, name: StringBinding): string[] => {
  const items = requireString(env, name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new SettingsError(`${name} is empty`);
  return items;
};

const requireExactUrl = (env: Env, name: StringBinding): string => {
  const raw = requireString(env, name);
  try {
    new URL(raw);
  } catch {
    throw new SettingsError(`${name} must be a URL`);
  }
  return raw;
};

const requireBaseUrl = (env: Env, name: StringBinding): string =>
  requireExactUrl(env, name).replace(/\/+$/, "");

const readPayoutSettings = (env: Env): PayoutSettings => {
  const chainName = requireString(env, "PAYOUT_CHAIN");
  const payoutChain = PAYOUT_CHAINS[chainName];
  if (!payoutChain)
    throw new SettingsError(`PAYOUT_CHAIN must be one of ${Object.keys(PAYOUT_CHAINS).join(", ")}`);

  const privateKey = requireString(env, "PAYOUT_PRIVATE_KEY");
  if (!PRIVATE_KEY_PATTERN.test(privateKey))
    throw new SettingsError("PAYOUT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");

  return {
    chain: payoutChain.chain,
    networkName: payoutChain.networkName,
    currency: payoutChain.chain.nativeCurrency.symbol,
    priceSymbol: requireString(env, "PAYOUT_PRICE_SYMBOL"),
    usdAmount: requireDecimal(env, "CLAIM_USD_AMOUNT"),
    maxTokenAmountPerClaim: requireDecimal(env, "MAX_TOKEN_AMOUNT_PER_CLAIM"),
    confirmWaitSeconds: requireInteger(env, "PAYOUT_CONFIRM_WAIT_SECONDS", 0),
    privateKey: privateKey as Hex,
    rpcUrl: requireExactUrl(env, "RPC_URL"),
    alchemyApiKey: requireString(env, "ALCHEMY_API_KEY"),
  };
};

export const readSettings = (env: Env): Settings => {
  const paraEnvironment = requireString(env, "PARA_ENVIRONMENT");
  const paraJwksUrl = PARA_JWKS_URLS[paraEnvironment];
  if (!paraJwksUrl)
    throw new SettingsError(
      `PARA_ENVIRONMENT must be one of ${Object.keys(PARA_JWKS_URLS).join(", ")}`,
    );

  return {
    allowedOrigins: requireList(env, "ALLOWED_ORIGINS").map((origin) => origin.replace(/\/+$/, "")),
    xRedirectUri: requireExactUrl(env, "X_REDIRECT_URI"),
    xClientId: requireString(env, "X_CLIENT_ID"),
    xClientSecret: requireString(env, "X_CLIENT_SECRET"),
    paraJwksUrl,
    paraJwtAudience: requireString(env, "PARA_JWT_AUDIENCE"),
    supabase: {
      url: requireBaseUrl(env, "SUPABASE_URL"),
      serviceRoleKey: requireString(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    claimsPaused: requireBoolean(env, "CLAIMS_PAUSED"),
    release: {
      dailyLimit: requireInteger(env, "DAILY_SPOT_LIMIT", 0),
      batchSize: requireInteger(env, "RELEASE_BATCH_SIZE", 1),
      intervalHours: requireInteger(env, "RELEASE_INTERVAL_HOURS", 1),
    },
    eligibility: {
      verifiedTypes: requireList(env, "VERIFIED_TYPES").map((type) => type.toLowerCase()),
      acceptIdentityVerified: requireBoolean(env, "ACCEPT_IDENTITY_VERIFIED"),
      minVerifiedFollowers: requireInteger(env, "MIN_VERIFIED_FOLLOWERS", 0),
      ratioCheckEnabled: requireBoolean(env, "RATIO_CHECK_ENABLED"),
      maxFollowingPerFollower: requireInteger(env, "MAX_FOLLOWING_PER_FOLLOWER", 1),
    },
    payout: readPayoutSettings(env),
    lowBalanceAlertUsd: requireDecimal(env, "LOW_BALANCE_ALERT_USD"),
    lowBalanceAlertIntervalHours: requireInteger(env, "LOW_BALANCE_ALERT_INTERVAL_HOURS", 1),
  };
};
