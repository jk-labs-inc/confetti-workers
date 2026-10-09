import type { Hex } from "viem";
import type { LedgerAttempt, LedgerEntry, LedgerState, SignedTransfer } from "./types";

interface PayoutRow extends Record<string, SqlStorageValue> {
  claim_id: string;
  recipient: string;
  value_wei: string;
  nonce: number;
  state: string;
  confirmed_hash: string | null;
  recorded: number;
  nonce_consumed_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AttemptRow extends Record<string, SqlStorageValue> {
  hash: string;
  claim_id: string;
  raw_transaction: string;
  gas: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  created_at: number;
}

const OUTSTANDING_STATES: LedgerState[] = ["signed", "sent"];
const FINAL_STATES: LedgerState[] = ["confirmed", "failed", "abandoned"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payouts (
    claim_id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    value_wei TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    state TEXT NOT NULL,
    confirmed_hash TEXT,
    recorded INTEGER NOT NULL DEFAULT 0,
    nonce_consumed_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payout_attempts (
    claim_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    raw_transaction TEXT NOT NULL,
    gas TEXT NOT NULL,
    max_fee_per_gas TEXT NOT NULL,
    max_priority_fee_per_gas TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, hash)
  )`,
];

const placeholders = (values: unknown[]) => values.map(() => "?").join(", ");

const toAttempt = (row: AttemptRow): LedgerAttempt => ({
  hash: row.hash as Hex,
  rawTransaction: row.raw_transaction as Hex,
  gas: BigInt(row.gas),
  fees: {
    maxFeePerGas: BigInt(row.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas),
  },
  createdAt: row.created_at,
});

export class PayoutLedger {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  private attempts(claimId: string): LedgerAttempt[] {
    return this.sql
      .exec<AttemptRow>(
        "SELECT * FROM payout_attempts WHERE claim_id = ? ORDER BY created_at DESC, rowid DESC",
        claimId,
      )
      .toArray()
      .map(toAttempt);
  }

  private toEntry(row: PayoutRow): LedgerEntry {
    return {
      claimId: row.claim_id,
      recipient: row.recipient as Hex,
      valueWei: BigInt(row.value_wei),
      nonce: row.nonce,
      state: row.state as LedgerState,
      confirmedHash: row.confirmed_hash as Hex | null,
      nonceConsumedSeenAt: row.nonce_consumed_seen_at,
      attempts: this.attempts(row.claim_id),
    };
  }

  private entriesIn(states: LedgerState[], extraCondition = ""): LedgerEntry[] {
    return this.sql
      .exec<PayoutRow>(
        `SELECT * FROM payouts WHERE state IN (${placeholders(states)}) ${extraCondition} ORDER BY nonce`,
        ...states,
      )
      .toArray()
      .map((row) => this.toEntry(row));
  }

  private insertAttempt(claimId: string, transfer: SignedTransfer, now: number): void {
    this.sql.exec(
      `INSERT INTO payout_attempts (hash, claim_id, raw_transaction, gas, max_fee_per_gas, max_priority_fee_per_gas, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      transfer.hash,
      claimId,
      transfer.rawTransaction,
      transfer.gas.toString(),
      transfer.fees.maxFeePerGas.toString(),
      transfer.fees.maxPriorityFeePerGas.toString(),
      now,
    );
  }

  recordSigned(
    claimId: string,
    recipient: Hex,
    valueWei: bigint,
    transfer: SignedTransfer,
    now: number,
  ): void {
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO payouts (claim_id, recipient, value_wei, nonce, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'signed', ?, ?)`,
        claimId,
        recipient,
        valueWei.toString(),
        transfer.nonce,
        now,
        now,
      );
      this.insertAttempt(claimId, transfer, now);
    });
  }

  addAttempt(claimId: string, transfer: SignedTransfer, now: number): void {
    this.insertAttempt(claimId, transfer, now);
    this.sql.exec("UPDATE payouts SET updated_at = ? WHERE claim_id = ?", now, claimId);
  }

  setState(claimId: string, state: LedgerState, now: number, confirmedHash: Hex | null = null): void {
    this.sql.exec(
      "UPDATE payouts SET state = ?, confirmed_hash = COALESCE(?, confirmed_hash), recorded = 0, updated_at = ? WHERE claim_id = ?",
      state,
      confirmedHash,
      now,
      claimId,
    );
  }

  markNonceConsumedSeen(claimId: string, now: number): void {
    this.sql.exec("UPDATE payouts SET nonce_consumed_seen_at = ? WHERE claim_id = ?", now, claimId);
  }

  markRecorded(claimId: string): void {
    this.sql.exec("UPDATE payouts SET recorded = 1 WHERE claim_id = ?", claimId);
  }

  remove(claimId: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM payout_attempts WHERE claim_id = ?", claimId);
      this.sql.exec("DELETE FROM payouts WHERE claim_id = ?", claimId);
    });
  }

  entry(claimId: string): LedgerEntry | null {
    const row = this.sql
      .exec<PayoutRow>("SELECT * FROM payouts WHERE claim_id = ?", claimId)
      .toArray()[0];
    return row ? this.toEntry(row) : null;
  }

  outstanding(): LedgerEntry[] {
    return this.entriesIn(OUTSTANDING_STATES);
  }

  unrecordedFinal(): LedgerEntry[] {
    return this.entriesIn(FINAL_STATES, "AND recorded = 0");
  }

  highestTakenNonce(): number | null {
    const row = this.sql
      .exec<{ highest: number | null }>(
        `SELECT MAX(nonce) AS highest FROM payouts
         WHERE state IN (${placeholders(OUTSTANDING_STATES)}) OR confirmed_hash IS NOT NULL`,
        ...OUTSTANDING_STATES,
      )
      .one();
    return row.highest;
  }
}
