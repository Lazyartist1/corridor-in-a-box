import { describe, expect, it } from "vitest";
import { compareAmounts } from "@corridor/types";
import {
  DEFAULT_ESTIMATE_MARGIN_BPS,
  applyEstimateMargin,
  fetchIndicativePrice,
} from "@corridor/router";

describe("router indicative price from SEP-38 /price (#609)", () => {
  it("queries SEP-38 GET /price and computes cautiousDestAmount with estimateMarginBps", async () => {
    let seenUrl = "";
    let seenAuth = "";

    const res = await fetchIndicativePrice({
      domain: "indicative.example",
      quoteServer: "https://indicative.example/sep38",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
      estimateMarginBps: 50,
      authToken: "jwt-123",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        seenUrl = String(url);
        seenAuth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
        return new Response(
          JSON.stringify({
            // SEP-38: price is sell units per one buy unit (100 / 160000).
            price: "0.000625",
            total_price: "0.000625",
            sell_amount: "100",
            buy_amount: "160000",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(seenUrl).toContain("https://indicative.example/sep38/price?");
    expect(seenUrl).toContain("context=sep31");
    expect(seenUrl).toContain("sell_amount=100");
    expect(seenAuth).toBe("Bearer jwt-123");

    expect(res.value.label).toBe("indicative");
    expect(res.value.destAmount).toBe("160000");
    // rate is buy units per sell unit: 160000 / 100
    expect(res.value.price.rate).toBe("1600");
    // 160,000 * (1 - 50/10000) = 160,000 * 0.995 = 159200
    expect(res.value.cautiousDestAmount).toBe("159200");
    expect(res.value.reason).toContain("indicative");
  });

  const priceFeed = (body: Record<string, string>) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const base = {
    domain: "indicative.example",
    quoteServer: "https://indicative.example/sep38",
    sellAsset: "stellar:USDC:GISSUER",
    buyAsset: "iso4217:NGN",
    sellAmount: "100",
  } as const;

  it("derives the buy amount as sell ÷ price when buy_amount is missing", async () => {
    const res = await fetchIndicativePrice({
      ...base,
      fetchImpl: priceFeed({ price: "0.000625", total_price: "0.000625", sell_amount: "100" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.destAmount).toBe("160000");
    expect(res.value.price.rate).toBe("1600");
  });

  it("refuses a /price answer whose total_price × buy_amount misses sell_amount", async () => {
    const res = await fetchIndicativePrice({
      ...base,
      // The inverted reading (destination per source) the router must not accept.
      fetchImpl: priceFeed({
        price: "1600",
        total_price: "1600",
        sell_amount: "100",
        buy_amount: "160000",
      }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(res.error.message).toContain("internally inconsistent");
    }
  });

  it("applies the 50 bps default margin (RFC 0004 D3)", async () => {
    expect(DEFAULT_ESTIMATE_MARGIN_BPS).toBe(50);
    const res = await fetchIndicativePrice({
      ...base,
      fetchImpl: priceFeed({
        total_price: "0.000625",
        sell_amount: "100",
        buy_amount: "160000",
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.marginBps).toBe(50);
    expect(res.value.cautiousDestAmount).toBe("159200");
  });

  it("fails closed when /price carries neither buy_amount nor a usable price", async () => {
    const res = await fetchIndicativePrice({
      ...base,
      fetchImpl: priceFeed({ sell_amount: "100" }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("QUOTE_UNAVAILABLE");
  });

  it("ranks indicative cautiousDestAmount below an equal raw-rate locked option due to margin", () => {
    const discounted = applyEstimateMargin("1000", 100);
    expect(discounted.ok).toBe(true);
    if (!discounted.ok) return;
    expect(discounted.value).toBe("990");
    expect(compareAmounts(discounted.value, "1000")).toEqual({ ok: true, value: -1 });
  });

  it("fails closed when quote_server is missing or GET /price fails", async () => {
    const noServer = await fetchIndicativePrice({
      domain: "none.example",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
    });
    expect(noServer.ok).toBe(false);
    if (!noServer.ok) expect(noServer.error.code).toBe("QUOTE_UNAVAILABLE");

    const http503 = await fetchIndicativePrice({
      domain: "err.example",
      quoteServer: "https://err.example/sep38",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    expect(http503.ok).toBe(false);
    if (!http503.ok) expect(http503.error.retryable).toBe(true);
  });
});
