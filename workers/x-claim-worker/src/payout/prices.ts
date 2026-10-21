import type { PayoutSettings } from "../config/types";
import { DECIMAL_PATTERN } from "./amounts";
import { PayoutError } from "./errors";

const ALCHEMY_PRICES_URL = "https://api.g.alchemy.com/prices/v1";
const USD_CURRENCY = "usd";
const PRICE_REQUEST_TIMEOUT_MS = 5_000;

interface AlchemyPriceEntry {
  symbol?: unknown;
  prices?: { currency?: unknown; value?: unknown }[];
  error?: unknown;
}

const readPrices = async (url: URL): Promise<{ data?: AlchemyPriceEntry[] }> => {
  const signal = AbortSignal.timeout(PRICE_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, signal });
  } catch {
    throw new PayoutError("price_unavailable", "Could not reach the price API");
  }
  if (!response.ok)
    throw new PayoutError("price_unavailable", `Price API answered ${response.status}`);
  try {
    return (await response.json()) as { data?: AlchemyPriceEntry[] };
  } catch {
    throw new PayoutError("price_unavailable", "Could not read the price API answer");
  }
};

export const fetchUsdPrice = async (payout: PayoutSettings): Promise<string> => {
  const url = new URL(`${ALCHEMY_PRICES_URL}/${payout.alchemyApiKey}/tokens/by-symbol`);
  url.searchParams.set("symbols", payout.priceSymbol);

  const body = await readPrices(url);
  const entry = body.data?.find(
    (item) =>
      typeof item.symbol === "string" &&
      item.symbol.toUpperCase() === payout.priceSymbol.toUpperCase() &&
      !item.error,
  );
  const usd = entry?.prices?.find(
    (price) => typeof price.currency === "string" && price.currency.toLowerCase() === USD_CURRENCY,
  );
  if (typeof usd?.value !== "string")
    throw new PayoutError("price_unavailable", `No USD price for ${payout.priceSymbol}`);
  if (!DECIMAL_PATTERN.test(usd.value))
    throw new PayoutError("price_unavailable", `Unusable USD price ${usd.value} for ${payout.priceSymbol}`);
  return usd.value;
};
