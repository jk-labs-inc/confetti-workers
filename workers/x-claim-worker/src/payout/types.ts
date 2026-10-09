import type { Hex } from "viem";

export interface PayoutAmounts {
  usdPrice: string;
  tokenAmount: string;
  valueWei: bigint;
}

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface SignedTransfer {
  hash: Hex;
  rawTransaction: Hex;
  nonce: number;
  gas: bigint;
  fees: FeeQuote;
}

export interface TransferRequest {
  recipient: Hex;
  valueWei: bigint;
  nonce: number;
}

export type BroadcastResult = "sent" | "rejected" | "unknown";

type ReceiptStatus = "success" | "reverted";

export interface ConfirmedReceipt {
  hash: Hex;
  status: ReceiptStatus;
}

export type LedgerState = "signed" | "sent" | "confirmed" | "failed" | "abandoned";

export interface LedgerAttempt {
  hash: Hex;
  rawTransaction: Hex;
  gas: bigint;
  fees: FeeQuote;
  createdAt: number;
}

export interface LedgerEntry {
  claimId: string;
  recipient: Hex;
  valueWei: bigint;
  nonce: number;
  state: LedgerState;
  confirmedHash: Hex | null;
  nonceConsumedSeenAt: number | null;
  attempts: LedgerAttempt[];
}

export type PayoutErrorCode = "price_unavailable" | "price_out_of_bounds" | "chain_unavailable";
