import type { Hex } from "viem";

export type ParaProof = { kind: "para"; jwt: string; address: string };

export type SiweProof = { kind: "siwe"; message: string; signature: Hex };

export type WalletProof = ParaProof | SiweProof;

export interface ParaWalletClaim {
  type?: unknown;
  address?: unknown;
}

export interface IssuedNonce {
  nonce: string;
  expiresAt: string;
}
