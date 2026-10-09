import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { tokenAmountForUsd } from "../../src/payout/amounts";
import { PayoutError } from "../../src/payout/errors";

const convert = (usdPrice: string) =>
  tokenAmountForUsd({ usdAmount: "5", usdPrice, tokenDecimals: 18, maxTokenAmount: "150" });

describe("tokenAmountForUsd", () => {
  it("converts $5 at $0.25 into 20 tokens", () => {
    expect(convert("0.25")).toEqual({
      usdPrice: "0.25",
      tokenAmount: "20",
      valueWei: parseEther("20"),
    });
  });

  it("rounds down to six decimals", () => {
    const result = convert("0.103086");

    expect(result.tokenAmount).toBe("48.503191");
    expect(result.valueWei).toBe(parseEther("48.503191"));
  });

  it("never pays more than the USD amount is worth", () => {
    const { valueWei } = convert("0.3");

    expect(valueWei * 3n).toBeLessThanOrEqual(parseEther("5") * 10n);
  });

  it.each(["0", "abc", "-1", "1e-7"])("refuses the price %s", (price) => {
    expect(() => convert(price)).toThrow(PayoutError);
  });
});
