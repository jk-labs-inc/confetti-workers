import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Settings } from "../config/types";
import { isAllowedOrigin } from "../http/cors";
import { oneTimeStub } from "../oneTimeStore/oneTimeStore";
import { payoutPublicClient } from "../payout/chain";
import { loggableErrorText } from "../payout/errors";
import { ProofUnavailableError, WalletProofError } from "./errors";
import type { IssuedNonce, SiweProof } from "./types";

const WALLET_NONCE_TTL_SECONDS = 600;
const SIWE_NONCE_PATTERN = /^[A-Za-z0-9]{8,128}$/;

const allowedOriginOf = (uri: string | undefined, settings: Settings): string | null => {
  if (!uri) return null;
  try {
    const origin = new URL(uri).origin;
    return isAllowedOrigin(origin, settings.allowedOrigins) ? origin : null;
  } catch {
    return null;
  }
};

const signatureMatches = async (
  proof: SiweProof,
  address: `0x${string}`,
  settings: Settings,
): Promise<boolean> => {
  try {
    return await payoutPublicClient(settings.payout).verifyMessage({
      address,
      message: proof.message,
      signature: proof.signature,
      mode: "eoa",
    });
  } catch (error) {
    console.error("signature verification call failed", loggableErrorText(error));
    throw new ProofUnavailableError("Could not verify the signature on chain");
  }
};

export const verifySiweProof = async (
  proof: SiweProof,
  env: Env,
  settings: Settings,
): Promise<string> => {
  const message = parseSiweMessage(proof.message);
  const origin = allowedOriginOf(message.uri, settings);
  if (!message.address || !message.nonce || !SIWE_NONCE_PATTERN.test(message.nonce) || !origin)
    throw new WalletProofError("Signed message is missing its address, nonce or an allowed uri");
  if (message.domain !== new URL(origin).host)
    throw new WalletProofError("Signed message domain does not match its uri");
  if (message.chainId !== settings.payout.chain.id)
    throw new WalletProofError(`Signed message must use chain ID ${settings.payout.chain.id}`);
  if (!message.expirationTime)
    throw new WalletProofError("Signed message must have an expiration time");
  if (!validateSiweMessage({ message, domain: message.domain, nonce: message.nonce }))
    throw new WalletProofError("Signed message is expired or not yet valid");

  if (!(await signatureMatches(proof, message.address, settings)))
    throw new WalletProofError("Signed message signature is invalid");

  if ((await oneTimeStub(env, "nonce", message.nonce).take()) === null)
    throw new WalletProofError("Signed message nonce is unknown, used or expired");
  return message.address.toLowerCase();
};

export const issueWalletNonce = async (env: Env): Promise<IssuedNonce> => {
  const nonce = generateSiweNonce();
  const expiresAt = await oneTimeStub(env, "nonce", nonce).put(true, WALLET_NONCE_TTL_SECONDS);
  return { nonce, expiresAt: new Date(expiresAt).toISOString() };
};
