import {
  BaseError,
  createPublicClient,
  http,
  HttpRequestError,
  keccak256,
  RpcRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { PayoutSettings } from "../config/types";
import { loggableErrorText, PayoutError } from "./errors";
import type {
  BroadcastResult,
  ConfirmedReceipt,
  FeeQuote,
  SignedTransfer,
  TransferRequest,
} from "./types";

const ALREADY_BROADCAST_PATTERN = /already known|transaction already imported|known transaction/i;
const REPLACEMENT_FEE_BUMP_PERCENT = 115n;
const RECEIPT_POLL_INTERVAL_MS = 1000;

export interface PayoutChain {
  client: PublicClient;
  account: PrivateKeyAccount;
  chainId: number;
}

export const payoutPublicClient = (payout: PayoutSettings): PublicClient =>
  createPublicClient({ chain: payout.chain, transport: http(payout.rpcUrl) });

export const payoutChain = (payout: PayoutSettings): PayoutChain => ({
  client: payoutPublicClient(payout),
  account: privateKeyToAccount(payout.privateKey),
  chainId: payout.chain.id,
});

const chainCall = async <T>(description: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    console.error(`${description} failed`, loggableErrorText(error));
    throw new PayoutError("chain_unavailable", `${description} failed`);
  }
};

export const transactionCount = async (
  { client, account }: PayoutChain,
  blockTag: "latest" | "pending",
): Promise<number> =>
  chainCall("nonce lookup", () => client.getTransactionCount({ address: account.address, blockTag }));

export const payoutBalance = async ({ client, account }: PayoutChain): Promise<bigint> =>
  chainCall("balance lookup", () => client.getBalance({ address: account.address }));

export const currentFees = async ({ client }: PayoutChain): Promise<FeeQuote> =>
  chainCall("fee estimate", async () => {
    const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
    return { maxFeePerGas, maxPriorityFeePerGas };
  });

export const bumpedFees = (previous: FeeQuote, current: FeeQuote): FeeQuote => {
  const bump = (value: bigint) => (value * REPLACEMENT_FEE_BUMP_PERCENT) / 100n;
  const maxPriorityFeePerGas = [bump(previous.maxPriorityFeePerGas), current.maxPriorityFeePerGas].reduce(
    (a, b) => (a > b ? a : b),
  );
  const maxFeePerGas = [bump(previous.maxFeePerGas), current.maxFeePerGas, maxPriorityFeePerGas].reduce(
    (a, b) => (a > b ? a : b),
  );
  return { maxFeePerGas, maxPriorityFeePerGas };
};

export const isBelowMarket = (fees: FeeQuote, market: FeeQuote): boolean =>
  fees.maxFeePerGas < market.maxFeePerGas || fees.maxPriorityFeePerGas < market.maxPriorityFeePerGas;

export const signTransfer = async (
  chain: PayoutChain,
  transfer: TransferRequest,
  fees: FeeQuote,
  knownGas?: bigint,
): Promise<SignedTransfer> => {
  const gas =
    knownGas ??
    (await chainCall("gas estimate", () =>
      chain.client.estimateGas({
        account: chain.account.address,
        to: transfer.recipient,
        value: transfer.valueWei,
      }),
    ));
  const rawTransaction = await chain.account.signTransaction({
    chainId: chain.chainId,
    type: "eip1559",
    to: transfer.recipient,
    value: transfer.valueWei,
    nonce: transfer.nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return { hash: keccak256(rawTransaction), rawTransaction, nonce: transfer.nonce, gas, fees };
};

export const broadcast = async ({ client }: PayoutChain, rawTransaction: Hex): Promise<BroadcastResult> => {
  try {
    await client.sendRawTransaction({ serializedTransaction: rawTransaction });
    return "sent";
  } catch (error) {
    if (ALREADY_BROADCAST_PATTERN.test(loggableErrorText(error))) return "sent";
    const transportFailure =
      error instanceof BaseError &&
      error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError) !== null &&
      error.walk((cause) => cause instanceof RpcRequestError) === null;
    console.error("broadcast failed", loggableErrorText(error));
    return transportFailure ? "unknown" : "rejected";
  }
};

export const receiptFor = async (
  { client }: PayoutChain,
  hashes: Hex[],
): Promise<ConfirmedReceipt | null> => {
  for (const hash of hashes) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return { hash, status: receipt.status };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) continue;
      throw new PayoutError("chain_unavailable", "receipt lookup failed");
    }
  }
  return null;
};

export const mayStillMine = async (chain: PayoutChain, transfer: SignedTransfer): Promise<boolean> => {
  try {
    if (await receiptFor(chain, [transfer.hash])) return true;
    return (await transactionCount(chain, "pending")) > transfer.nonce;
  } catch {
    return true;
  }
};

export const waitForReceipt = async (
  chain: PayoutChain,
  hashes: Hex[],
  timeoutMs: number,
): Promise<ConfirmedReceipt | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await receiptFor(chain, hashes).catch(() => null);
    if (receipt || Date.now() >= deadline) return receipt;
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
  }
};
