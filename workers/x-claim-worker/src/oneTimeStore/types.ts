export type OneTimeKind = "xstate" | "nonce";

export interface StoredRecord {
  value: unknown;
  expiresAt: number;
}
