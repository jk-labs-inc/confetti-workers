import { jsonResponse, NO_STORE } from "../http/responses";
import type { RouteContext } from "../http/types";
import { issueWalletNonce } from "../walletProof/siwe";

export const handleNonce = async ({ env, settings }: RouteContext) =>
  jsonResponse({ ...(await issueWalletNonce(env)), chainId: settings.payout.chain.id }, 200, NO_STORE);
