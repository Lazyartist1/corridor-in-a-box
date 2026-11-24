// Indicative price fetcher using SEP-38 GET /price (#609).
//
// When an anchor offers no firm quote (POST /quote) but exposes a live rate
// feed (GET /price), the option is labelled "indicative" and its ranking amount
// (`cautiousDestAmount`) is discounted by `estimateMarginBps`.
//
// SEP-38 `price` / `total_price` are SELL units per ONE BUY unit (the same way
// adapter-kit reads a firm quote), so the buy amount is `sell ÷ price`, never
// `sell × price`. The reported `rate` is the inverse: buy units per sell unit.

import { totalPriceProblem } from "@corridor/adapter-kit";
import {
  applyPrice,
  fail,
  fromScaled,
  isValidAmount,
  ok,
  STROOP_SCALE,
  toScaled,
  type Outcome,
} from "@corridor/types";

/** Default ranking discount for indicative prices: 50 bps (RFC 0004 D3). */
export const DEFAULT_ESTIMATE_MARGIN_BPS = 50; // 0.50%

export interface IndicativePriceRequest {
  readonly domain: string;
  readonly protocol?: string;
  readonly quoteServer?: string;
  readonly sellAsset: string;
  readonly buyAsset: string;
  readonly sellAmount: string;
  /** SEP-38 context query parameter (default `"sep31"`). */
  readonly context?: string;
  /** Safety discount applied to `destAmount` when ranking (default 50 bps). */
  readonly estimateMarginBps?: number;
  /** Optional SEP-10 bearer JWT if the anchor authenticates GET /price. */
  readonly authToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface IndicativeRouteOption {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly label: "indicative";
  readonly price: {
    readonly label: "indicative";
    /** Buy (destination) units per one sell (source) unit. */
    readonly rate: string;
    readonly destAmount: string;
    readonly cautiousDestAmount: string;
  };
  readonly destAmount: string;
  readonly cautiousDestAmount: string;
  readonly marginBps: number;
  readonly reason: string;
}

/**
 * Compute `amount * (1 - marginBps / 10_000)` using scaled BigInt arithmetic so
 * floating-point precision loss is impossible.
 */
export function applyEstimateMargin(
  amount: string,
  marginBps: number = DEFAULT_ESTIMATE_MARGIN_BPS,
  scale = STROOP_SCALE,
): Outcome<string> {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    return fail(
      "AMOUNT_INVALID",
      `estimateMarginBps must be an integer in [0, 9999] (got ${marginBps})`,
    );
  }
  const factor = 10n ** BigInt(scale);
  const multiplierScaled = (BigInt(10_000 - marginBps) * factor) / 10_000n;
  const multiplier = fromScaled(multiplierScaled, scale);
  return applyPrice(amount, multiplier, scale);
}

/** `numerator ÷ denominator` on scaled integers, rounded half-up to `scale` places. */
function divideAmounts(
  numerator: string,
  denominator: string,
  scale = STROOP_SCALE,
): Outcome<string> {
  const n = toScaled(numerator, scale);
  if (!n.ok) return n;
  const d = toScaled(denominator, scale);
  if (!d.ok) return d;
  if (d.value === 0n) return fail("AMOUNT_INVALID", "cannot divide by a zero amount");
  const factor = 10n ** BigInt(scale);
  const scaledNumerator = n.value * factor;
  const quotient = (scaledNumerator * 2n + d.value) / (2n * d.value);
  return ok(fromScaled(quotient, scale));
}

function trimTrailingSlashes(value: string | undefined): string {
  if (!value) {
    return "";
  }
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Fetch an indicative price via SEP-38 `GET /price` and compute the discounted
 * `cautiousDestAmount` used for ranking.
 */
export async function fetchIndicativePrice(
  req: IndicativePriceRequest,
): Promise<Outcome<IndicativeRouteOption>> {
  const quoteServer = trimTrailingSlashes(req.quoteServer);
  if (!quoteServer) {
    return fail("QUOTE_UNAVAILABLE", `${req.domain}: anchor exposes no SEP-38 quote server`);
  }

  const marginBps = req.estimateMarginBps ?? DEFAULT_ESTIMATE_MARGIN_BPS;
  const fetchImpl = req.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    context: req.context ?? "sep31",
    sell_asset: req.sellAsset,
    buy_asset: req.buyAsset,
    sell_amount: req.sellAmount,
  });

  try {
    const res = await fetchImpl(`${quoteServer}/price?${params.toString()}`, {
      method: "GET",
      headers: req.authToken ? { authorization: `Bearer ${req.authToken}` } : undefined,
    });
    if (!res.ok) {
      return fail("QUOTE_UNAVAILABLE", `${req.domain}: GET /price HTTP ${res.status}`, {
        retryable: res.status >= 500,
      });
    }

    const body = (await res.json()) as {
      price?: string;
      total_price?: string;
      buy_amount?: string;
      sell_amount?: string;
    };

    const sellAmount =
      typeof body.sell_amount === "string" && isValidAmount(body.sell_amount)
        ? body.sell_amount
        : req.sellAmount;
    // Sell units per one buy unit. `total_price` includes fees, so prefer it.
    const sellPerBuy = [body.total_price, body.price].find(
      (p): p is string => typeof p === "string" && isValidAmount(p),
    );

    let destAmount: string;
    if (typeof body.buy_amount === "string" && isValidAmount(body.buy_amount)) {
      destAmount = body.buy_amount;
    } else if (sellPerBuy) {
      const derived = divideAmounts(sellAmount, sellPerBuy);
      if (!derived.ok) {
        return fail("QUOTE_UNAVAILABLE", `${req.domain}: GET /price returned a zero price`);
      }
      destAmount = derived.value;
    } else {
      return fail(
        "QUOTE_UNAVAILABLE",
        `${req.domain}: GET /price returned neither buy_amount nor a valid price`,
      );
    }

    const inconsistent = totalPriceProblem({
      quoteId: "GET /price",
      totalPrice: body.total_price,
      buyAmount: destAmount,
      sellAmount,
    });
    if (inconsistent) return fail("QUOTE_UNAVAILABLE", `${req.domain}: ${inconsistent}`);

    const rate = divideAmounts(destAmount, sellAmount);
    if (!rate.ok) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `${req.domain}: GET /price returned a zero sell_amount`,
      );
    }

    const cautious = applyEstimateMargin(destAmount, marginBps);
    if (!cautious.ok) return cautious;

    return ok({
      domain: req.domain,
      receivingDomain: req.domain,
      protocol: req.protocol ?? "sep31",
      label: "indicative",
      price: {
        label: "indicative",
        rate: rate.value,
        destAmount,
        cautiousDestAmount: cautious.value,
      },
      destAmount,
      cautiousDestAmount: cautious.value,
      marginBps,
      reason: `indicative: live /price (-${marginBps} bps margin)`,
    });
  } catch (cause) {
    return fail("ANCHOR_UNAVAILABLE", `${req.domain}: GET /price request failed`, {
      retryable: true,
      cause,
    });
  }
}
