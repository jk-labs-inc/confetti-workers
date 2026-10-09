import { base64url } from "jose";
import { isAddress, isHex } from "viem";
import type { Settings } from "../config/types";
import { WALLET_PROOF_HEADER } from "./constants";
import { WalletProofError } from "./errors";
import { verifyParaProof } from "./para";
import { verifySiweProof } from "./siwe";
import type { WalletProof } from "./types";

const MAX_PROOF_HEADER_LENGTH = 16_384;

const parseWalletProofHeader = (header: string | null): WalletProof => {
  if (!header) throw new WalletProofError(`Missing ${WALLET_PROOF_HEADER} header`);
  if (header.length > MAX_PROOF_HEADER_LENGTH)
    throw new WalletProofError("Wallet proof is too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64url.decode(header)));
  } catch {
    throw new WalletProofError("Wallet proof must be base64url-encoded JSON");
  }
  if (!parsed || typeof parsed !== "object")
    throw new WalletProofError("Wallet proof must be a JSON object");

  const proof = parsed as Record<string, unknown>;
  if (proof.kind === "para") {
    if (typeof proof.jwt !== "string" || typeof proof.address !== "string" || !isAddress(proof.address, { strict: false }))
      throw new WalletProofError("Para proof needs jwt and a 0x address");
    return { kind: "para", jwt: proof.jwt, address: proof.address };
  }
  if (proof.kind === "siwe") {
    if (typeof proof.message !== "string" || typeof proof.signature !== "string" || !isHex(proof.signature))
      throw new WalletProofError("SIWE proof needs message and a hex signature");
    return { kind: "siwe", message: proof.message, signature: proof.signature };
  }
  throw new WalletProofError('Wallet proof kind must be "para" or "siwe"');
};

export const verifyWalletProof = async (
  request: Request,
  env: Env,
  settings: Settings,
): Promise<string> => {
  const proof = parseWalletProofHeader(request.headers.get(WALLET_PROOF_HEADER));
  return proof.kind === "para"
    ? verifyParaProof(proof, settings)
    : verifySiweProof(proof, env, settings);
};
