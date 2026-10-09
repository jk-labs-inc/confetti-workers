import { DurableObject } from "cloudflare:workers";
import { formatUnits, type Hex } from "viem";
import { readSettings } from "../config/settings";
import type { Settings } from "../config/types";
import { isWorthLessThanUsd, tokenAmountForUsd, usdValueLabel } from "../payout/amounts";
import {
  broadcast,
  currentFees,
  mayStillMine,
  payoutBalance,
  payoutChain,
  signTransfer,
  transactionCount,
  waitForReceipt,
  type PayoutChain,
} from "../payout/chain";
import { PayoutError } from "../payout/errors";
import { PayoutLedger } from "../payout/ledger";
import { fetchUsdPrice } from "../payout/prices";
import type { ConfirmedReceipt, LedgerState, PayoutAmounts, SignedTransfer } from "../payout/types";
import { countActiveClaimsSince, getClaim, hasActiveClaim, insertClaim } from "../supabase/claimsHistory";
import { SupabaseError } from "../supabase/client";
import type { ClaimRow, NewClaim, RejectReason, SocialLinkRow, SupabaseConfig } from "../supabase/types";
import { evaluateEligibility } from "./eligibility";
import { abandonIfUnreserved, recordPayoutResult, type FinalLedgerState } from "./payoutResults";
import { reconcilePayouts } from "./reconcile";
import { MS_PER_HOUR, nextReleaseTime, releasedSpotsAt, spotsSnapshot, utcDayStart } from "./releaseSchedule";
import type {
  ClaimOutcome,
  MaintenanceReport,
  PaidDetails,
  PriceCache,
  Reservation,
  SpotsSnapshot,
  UsedTodayCache,
} from "./types";

const COORDINATOR_NAME = "claims";
const USED_TODAY_CACHE_MS = 15_000;
const PRICE_CACHE_MS = 60_000;
const LOW_BALANCE_ALERTED_AT_KEY = "lowBalanceAlertedAt";

const settled = (outcome: ClaimOutcome): Reservation => ({ kind: "settled", outcome });

const queueFreeRejection = (settings: Settings, link: SocialLinkRow): RejectReason | null =>
  settings.claimsPaused ? "paused" : evaluateEligibility(link, settings.eligibility).rejectReason;

export class ClaimCoordinator extends DurableObject<Env> {
  private readonly ledger: PayoutLedger;
  private queue: Promise<unknown> = Promise.resolve();
  private usedTodayCache: UsedTodayCache | null = null;
  private priceCache: PriceCache | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new PayoutLedger(ctx.storage);
  }

  async spots(): Promise<SpotsSnapshot> {
    const settings = readSettings(this.env);
    const now = Date.now();
    const usedToday = await this.cachedUsedToday(settings, now);
    return spotsSnapshot(now, usedToday, settings.release, settings.claimsPaused);
  }

  async claim(link: SocialLinkRow): Promise<ClaimOutcome> {
    const settings = readSettings(this.env);
    const rejectReason = queueFreeRejection(settings, link);
    const reservation: Reservation = rejectReason
      ? { kind: "rejected", reason: rejectReason }
      : await this.serialize(() => this.checkAndReserve(settings, link));
    switch (reservation.kind) {
      case "rejected":
        return this.reject(settings.supabase, link, reservation.reason, reservation.nextReleaseAt);
      case "settled":
        return reservation.outcome;
      case "sent":
        return this.confirm(settings, reservation.details);
    }
  }

  async runMaintenance(): Promise<MaintenanceReport> {
    const settings = readSettings(this.env);
    const chain = payoutChain(settings.payout);
    const report = await this.serialize(() => reconcilePayouts(this.ledger, chain, settings.supabase));
    this.usedTodayCache = null;
    return { ...report, lowBalanceAlerted: await this.alertIfBalanceLow(settings, chain) };
  }

  private async alertIfBalanceLow(settings: Settings, chain: PayoutChain): Promise<boolean> {
    const now = Date.now();
    const lastAlertedAt = this.ctx.storage.kv.get<number>(LOW_BALANCE_ALERTED_AT_KEY);
    if (lastAlertedAt !== undefined && now - lastAlertedAt < settings.lowBalanceAlertIntervalHours * MS_PER_HOUR)
      return false;

    let balanceWei: bigint;
    let usdPrice: string;
    try {
      [balanceWei, usdPrice] = await Promise.all([payoutBalance(chain), this.usdPrice(settings)]);
    } catch (error) {
      console.error("low-balance check could not run", error);
      return false;
    }
    const { decimals } = settings.payout.chain.nativeCurrency;
    if (!isWorthLessThanUsd(balanceWei, usdPrice, settings.lowBalanceAlertUsd, decimals)) return false;

    console.error(
      `ALERT: Payout wallet ${chain.account.address} on ${settings.payout.networkName} holds ` +
        `${formatUnits(balanceWei, decimals)} ${settings.payout.currency} ` +
        `(about $${usdValueLabel(balanceWei, usdPrice, decimals)}), below the $${settings.lowBalanceAlertUsd} alert level.`,
    );
    this.ctx.storage.kv.put(LOW_BALANCE_ALERTED_AT_KEY, now);
    return true;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private cachedUsedToday(settings: Settings, now: number): Promise<number> {
    const dayStart = utcDayStart(now);
    const cache = this.usedTodayCache;
    if (cache && cache.dayStart === dayStart && now - cache.fetchedAt < USED_TODAY_CACHE_MS)
      return cache.usedToday;

    const entry: UsedTodayCache = {
      dayStart,
      fetchedAt: now,
      usedToday: countActiveClaimsSince(settings.supabase, new Date(dayStart)),
    };
    this.usedTodayCache = entry;
    entry.usedToday.catch(() => {
      if (this.usedTodayCache === entry) this.usedTodayCache = null;
    });
    return entry.usedToday;
  }

  private async usdPrice(settings: Settings): Promise<string> {
    const now = Date.now();
    if (this.priceCache && now - this.priceCache.fetchedAt < PRICE_CACHE_MS) return this.priceCache.usdPrice;
    const usdPrice = await fetchUsdPrice(settings.payout);
    this.priceCache = { usdPrice, fetchedAt: now };
    return usdPrice;
  }

  private async nextNonce(chain: PayoutChain): Promise<number> {
    const pending = await transactionCount(chain, "pending");
    const highestTaken = this.ledger.highestTakenNonce();
    return highestTaken === null ? pending : Math.max(pending, highestTaken + 1);
  }

  private async abandonUnreservedPayouts(config: SupabaseConfig): Promise<void> {
    for (const entry of this.ledger.outstanding()) await abandonIfUnreserved(this.ledger, config, entry);
  }

  private async recordAttempt(config: SupabaseConfig, claim: NewClaim): Promise<void> {
    try {
      await insertClaim(config, claim);
    } catch (error) {
      console.error("recording claim attempt failed", claim.status, error);
    }
  }

  private async reservePendingClaim(
    config: SupabaseConfig,
    claim: NewClaim & Pick<ClaimRow, "id">,
  ): Promise<"reserved" | "duplicate"> {
    try {
      await insertClaim(config, claim);
      return "reserved";
    } catch (error) {
      if (error instanceof SupabaseError && error.isUniqueViolation) return "duplicate";
      if (await getClaim(config, claim.id).catch(() => null)) return "reserved";
      throw error;
    }
  }

  private async reject(
    config: SupabaseConfig,
    link: SocialLinkRow,
    reason: RejectReason,
    nextReleaseAt?: string,
  ): Promise<ClaimOutcome> {
    await this.recordAttempt(config, {
      address: link.address,
      platform_user_id: link.platform_user_id,
      status: "rejected",
      reject_reason: reason,
    });
    return { outcome: "rejected", reason, ...(nextReleaseAt ? { nextReleaseAt } : {}) };
  }

  private async checkAndReserve(settings: Settings, link: SocialLinkRow): Promise<Reservation> {
    const now = Date.now();
    const [alreadyClaimed, usedToday] = await Promise.all([
      hasActiveClaim(settings.supabase, link.address, link.platform_user_id),
      countActiveClaimsSince(settings.supabase, new Date(utcDayStart(now))),
    ]);
    if (alreadyClaimed) return { kind: "rejected", reason: "wallet_claimed" };
    if (usedToday >= releasedSpotsAt(now, settings.release))
      return {
        kind: "rejected",
        reason: "no_spots",
        nextReleaseAt: new Date(nextReleaseTime(now, settings.release)).toISOString(),
      };

    return this.reserveAndSend(settings, link);
  }

  private async prepareTransfer(
    settings: Settings,
    chain: PayoutChain,
    recipient: Hex,
  ): Promise<{ amounts: PayoutAmounts; transfer: SignedTransfer }> {
    const [usdPrice, nonce, fees] = await Promise.all([
      this.usdPrice(settings),
      this.nextNonce(chain),
      currentFees(chain),
    ]);
    const amounts = tokenAmountForUsd({
      usdAmount: settings.payout.usdAmount,
      usdPrice,
      tokenDecimals: settings.payout.chain.nativeCurrency.decimals,
      maxTokenAmount: settings.payout.maxTokenAmountPerClaim,
    });
    const transfer = await signTransfer(chain, { recipient, valueWei: amounts.valueWei, nonce }, fees);
    return { amounts, transfer };
  }

  private async reserveAndSend(settings: Settings, link: SocialLinkRow): Promise<Reservation> {
    const config = settings.supabase;
    const chain = payoutChain(settings.payout);
    const recipient = link.address as Hex;
    const base = { address: link.address, platform_user_id: link.platform_user_id };
    const payoutColumns = {
      usd_amount: settings.payout.usdAmount,
      currency: settings.payout.currency,
      network_name: settings.payout.networkName,
    };

    await this.abandonUnreservedPayouts(config);
    let prepared: { amounts: PayoutAmounts; transfer: SignedTransfer };
    try {
      prepared = await this.prepareTransfer(settings, chain, recipient);
    } catch (error) {
      if (!(error instanceof PayoutError)) throw error;
      console.error("payout preparation failed", error.code, error.message);
      await this.recordAttempt(config, { ...base, ...payoutColumns, status: "failed" });
      return settled({ outcome: "payout_failed" });
    }
    const { amounts, transfer } = prepared;

    const claimId = crypto.randomUUID();
    this.ledger.recordSigned(claimId, recipient, amounts.valueWei, transfer, Date.now());
    const pendingRow = await this.reservePendingClaim(config, {
      ...base,
      ...payoutColumns,
      id: claimId,
      status: "pending",
      token_amount: amounts.tokenAmount,
      usd_price: amounts.usdPrice,
      tx_hash: transfer.hash,
    });
    if (pendingRow === "duplicate") {
      this.ledger.remove(claimId);
      return { kind: "rejected", reason: "wallet_claimed" };
    }
    this.usedTodayCache = null;

    const details: PaidDetails = {
      claimId,
      txHash: transfer.hash,
      tokenAmount: amounts.tokenAmount,
      usdAmount: settings.payout.usdAmount,
      currency: settings.payout.currency,
      network: settings.payout.networkName,
    };

    const result = await broadcast(chain, transfer.rawTransaction);
    if (result === "rejected" && !(await mayStillMine(chain, transfer))) {
      await this.finish(config, claimId, "failed");
      return settled({ outcome: "payout_failed" });
    }
    if (result === "sent") this.ledger.setState(claimId, "sent", Date.now());
    return { kind: "sent", details };
  }

  private async finish(
    config: SupabaseConfig,
    claimId: string,
    state: FinalLedgerState,
    confirmedHash: Hex | null = null,
  ): Promise<void> {
    if (state !== "confirmed") this.usedTodayCache = null;
    await recordPayoutResult(this.ledger, config, claimId, state, confirmedHash);
  }

  private async settleReceipt(
    settings: Settings,
    claimId: string,
    receipt: ConfirmedReceipt,
  ): Promise<LedgerState> {
    const entry = this.ledger.entry(claimId);
    if (!entry) return "abandoned";
    if (entry.state !== "signed" && entry.state !== "sent") return entry.state;
    const state = receipt.status === "success" ? "confirmed" : "failed";
    await this.finish(settings.supabase, claimId, state, receipt.hash);
    return state;
  }

  private async confirm(settings: Settings, details: PaidDetails): Promise<ClaimOutcome> {
    const receipt = await waitForReceipt(
      payoutChain(settings.payout),
      [details.txHash as Hex],
      settings.payout.confirmWaitSeconds * 1000,
    );
    if (!receipt) return { outcome: "pending", ...details };

    const state = await this.serialize(() => this.settleReceipt(settings, details.claimId, receipt));
    if (state === "confirmed") return { outcome: "paid", ...details, txHash: receipt.hash };
    if (state === "failed" || state === "abandoned") return { outcome: "payout_failed" };
    return { outcome: "pending", ...details };
  }
}

export const coordinatorStub = (env: Env) =>
  env.CLAIM_COORDINATOR.getByName(COORDINATOR_NAME);
