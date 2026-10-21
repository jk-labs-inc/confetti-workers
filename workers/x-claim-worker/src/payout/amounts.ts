import { formatUnits, parseUnits } from "viem";
import { PayoutError } from "./errors";
import type { PayoutAmounts } from "./types";

export const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const PRICE_SCALE_DECIMALS = 18;
const TOKEN_AMOUNT_DISPLAY_DECIMALS = 6;

export const tokenAmountForUsd = ({
  usdAmount,
  usdPrice,
  tokenDecimals,
  maxTokenAmount,
}: {
  usdAmount: string;
  usdPrice: string;
  tokenDecimals: number;
  maxTokenAmount: string;
}): PayoutAmounts => {
  if (!DECIMAL_PATTERN.test(usdPrice))
    throw new PayoutError("price_unavailable", `Unusable USD price ${usdPrice}`);
  const priceScaled = parseUnits(usdPrice, PRICE_SCALE_DECIMALS);
  if (priceScaled === 0n) throw new PayoutError("price_unavailable", "USD price is zero");

  const usdScaled = parseUnits(usdAmount, PRICE_SCALE_DECIMALS);
  const exactWei = (usdScaled * 10n ** BigInt(tokenDecimals)) / priceScaled;
  const displayStep = 10n ** BigInt(Math.max(0, tokenDecimals - TOKEN_AMOUNT_DISPLAY_DECIMALS));
  const valueWei = exactWei - (exactWei % displayStep);

  if (valueWei <= 0n) throw new PayoutError("price_out_of_bounds", "Payout rounds to zero");
  if (valueWei > parseUnits(maxTokenAmount, tokenDecimals))
    throw new PayoutError(
      "price_out_of_bounds",
      `Payout of ${formatUnits(valueWei, tokenDecimals)} exceeds the ${maxTokenAmount} cap`,
    );

  return { usdPrice, tokenAmount: formatUnits(valueWei, tokenDecimals), valueWei };
};

export const isWorthLessThanUsd = (
  balanceWei: bigint,
  usdPrice: string,
  thresholdUsd: string,
  tokenDecimals: number,
): boolean =>
  balanceWei * parseUnits(usdPrice, PRICE_SCALE_DECIMALS) <
  parseUnits(thresholdUsd, PRICE_SCALE_DECIMALS) * 10n ** BigInt(tokenDecimals);

export const usdValueLabel = (balanceWei: bigint, usdPrice: string, tokenDecimals: number): string =>
  (Number(formatUnits(balanceWei, tokenDecimals)) * Number(usdPrice)).toFixed(2);
