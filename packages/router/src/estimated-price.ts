import { isValidAmount, type Money } from "@corridor/types";
import { DEFAULT_ESTIMATE_MARGIN_BPS } from "./indicative-price";

export const DEFAULT_ESTIMATE_WINDOW_DAYS = 7;
/** Default ranking discount for estimated prices: 50 bps (RFC 0004 D3), shared with indicative prices. */
export { DEFAULT_ESTIMATE_MARGIN_BPS };
export const DEFAULT_MIN_ESTIMATE_SAMPLES = 100;
export const DEFAULT_MIN_ESTIMATE_SPAN_DAYS = 7;

export interface RateSample {
  rate: string;
  timestampMs: number;
}

export interface EstimatedPricePolicy {
  estimateWindowDays?: number;
  estimateMarginBps?: number;
  minEstimateSamples?: number;
  /**
   * How far back the supplied history must reach, in days: `now - oldest usable sample` across the
   * whole history, not just the window (RFC 0004 §3: "at least 7 days of data and at least 100
   * samples in the window"). Measuring it inside the window could never pass in practice: the
   * in-window samples only span the full window when one sits exactly on its start, so a
   * 15-minute collector would always fall short by one interval. `minEstimateSamples` is still
   * counted inside the window. Not capped by `estimateWindowDays`.
   */
  minEstimateSpanDays?: number;
}

export interface EstimatePriceRequest {
  receivingDomain: string;
  sourceAmount: Money;
  destAsset: string;
  history: readonly RateSample[];
  policy?: EstimatedPricePolicy;
  nowMs?: number;
}

export interface EstimatedPriceDetails {
  rate: string;
  p25Rate: string;
  marginBps: number;
  windowDays: number;
  sampleCount: number;
  basis: string;
}

export interface EstimatedPriceOffered {
  status: "offered";
  label: "estimated";
  receivingDomain: string;
  sourceAmount: Money;
  estimatedDestAmount: Money;
  price: EstimatedPriceDetails;
}

export interface EstimatedPriceDropped {
  status: "dropped";
  receivingDomain: string;
  reason: string;
  sampleCount: number;
  minSamples: number;
  minSpanDays: number;
  windowDays: number;
}

export type EstimatedPriceOutcome = EstimatedPriceOffered | EstimatedPriceDropped;

interface ParsedDecimal {
  digits: bigint;
  scale: number;
}

function parsePositiveDecimal(raw: string): ParsedDecimal | null {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const dot = trimmed.indexOf(".");
  if (dot === -1) {
    const digits = BigInt(trimmed);
    return digits > 0n ? { digits, scale: 0 } : null;
  }
  const whole = trimmed.slice(0, dot);
  const frac = trimmed.slice(dot + 1);
  const digits = BigInt(whole + frac);
  return digits > 0n ? { digits, scale: frac.length } : null;
}

function compareParsedDecimals(a: ParsedDecimal, b: ParsedDecimal): number {
  const maxScale = Math.max(a.scale, b.scale);
  const lhs = a.digits * 10n ** BigInt(maxScale - a.scale);
  const rhs = b.digits * 10n ** BigInt(maxScale - b.scale);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

function formatScaledDown(value: bigint, scale: number, outScale: number): string {
  let scaled = value;
  if (scale > outScale) {
    scaled = value / 10n ** BigInt(scale - outScale);
  } else if (scale < outScale) {
    scaled = value * 10n ** BigInt(outScale - scale);
  }

  const divisor = 10n ** BigInt(outScale);
  const whole = scaled / divisor;
  if (outScale === 0) {
    return whole.toString();
  }
  const frac = (scaled % divisor).toString().padStart(outScale, "0");
  const trimmedFrac = frac.replace(/0+$/, "");
  return trimmedFrac.length > 0 ? `${whole}.${trimmedFrac}` : whole.toString();
}

function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Computes an estimated fallback option from historical rate samples inside the
 * configured window (P25 minus margin). Drops the candidate when the window holds
 * fewer than `minEstimateSamples` usable samples, or when the whole history reaches
 * back less than `minEstimateSpanDays` (now minus the oldest usable sample).
 */
export function buildEstimatedOption(request: EstimatePriceRequest): EstimatedPriceOutcome {
  if (!isValidAmount(request.sourceAmount.amount)) {
    throw new RangeError(
      `Invalid source amount for estimated pricing: ${request.sourceAmount.amount}`,
    );
  }

  const windowDays = request.policy?.estimateWindowDays ?? DEFAULT_ESTIMATE_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new RangeError("estimateWindowDays must be positive");
  }

  const marginBps = request.policy?.estimateMarginBps ?? DEFAULT_ESTIMATE_MARGIN_BPS;
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    throw new RangeError("estimateMarginBps must be an integer between 0 and 9999");
  }

  const minSamples = request.policy?.minEstimateSamples ?? DEFAULT_MIN_ESTIMATE_SAMPLES;
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new RangeError("minEstimateSamples must be an integer >= 1");
  }

  const minSpanDays = request.policy?.minEstimateSpanDays ?? DEFAULT_MIN_ESTIMATE_SPAN_DAYS;
  if (!Number.isFinite(minSpanDays) || minSpanDays < 0) {
    throw new RangeError("minEstimateSpanDays must be a number >= 0");
  }

  const nowMs = request.nowMs ?? Date.now();
  const windowStartMs = nowMs - windowDays * 86_400_000;

  const validSamples: Array<{ rate: string; parsed: ParsedDecimal; timestampMs: number }> = [];
  // The oldest usable sample in the whole history: how far back the data reaches.
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const sample of request.history) {
    if (!Number.isFinite(sample.timestampMs) || sample.timestampMs > nowMs) {
      continue;
    }
    const parsed = parsePositiveDecimal(sample.rate);
    if (!parsed) {
      continue;
    }
    oldestMs = Math.min(oldestMs, sample.timestampMs);
    if (sample.timestampMs < windowStartMs) {
      continue;
    }
    validSamples.push({ rate: sample.rate.trim(), parsed, timestampMs: sample.timestampMs });
  }

  if (validSamples.length < minSamples) {
    return {
      status: "dropped",
      receivingDomain: request.receivingDomain,
      reason: `dropped: unpriceable (${formatCount(validSamples.length)} of ${formatCount(minSamples)} samples in ${windowDays}d window)`,
      sampleCount: validSamples.length,
      minSamples,
      minSpanDays,
      windowDays,
    };
  }

  // At least one usable sample is in the window here, so oldestMs is finite.
  const historyMs = nowMs - oldestMs;
  if (historyMs < minSpanDays * 86_400_000) {
    const historyDays = Math.floor((historyMs / 86_400_000) * 10) / 10;
    return {
      status: "dropped",
      receivingDomain: request.receivingDomain,
      reason: `dropped: unpriceable (history covers ${historyDays.toFixed(1)}d of ${minSpanDays}d needed)`,
      sampleCount: validSamples.length,
      minSamples,
      minSpanDays,
      windowDays,
    };
  }

  validSamples.sort((a, b) => compareParsedDecimals(a.parsed, b.parsed));
  const p25Index = Math.floor(0.25 * (validSamples.length - 1));
  const p25 = validSamples[p25Index]!;

  const rateScale = Math.max(p25.parsed.scale, 7);
  const p25AtScale = p25.parsed.digits * 10n ** BigInt(rateScale - p25.parsed.scale);
  const marginFactor = BigInt(10_000 - marginBps);
  const discountedDigits = (p25AtScale * marginFactor) / 10_000n;
  const discountedRate = formatScaledDown(discountedDigits, rateScale, rateScale);

  const parsedSource = parsePositiveDecimal(request.sourceAmount.amount);
  if (!parsedSource) {
    throw new RangeError(
      `Source amount must be positive for estimated pricing: ${request.sourceAmount.amount}`,
    );
  }

  const productDigits = parsedSource.digits * discountedDigits;
  const productScale = parsedSource.scale + rateScale;
  const destOutScale = Math.min(7, Math.max(parsedSource.scale, p25.parsed.scale, 2));
  const destAmount = formatScaledDown(productDigits, productScale, destOutScale);

  return {
    status: "offered",
    label: "estimated",
    receivingDomain: request.receivingDomain,
    sourceAmount: request.sourceAmount,
    estimatedDestAmount: {
      asset: request.destAsset,
      amount: destAmount,
    },
    price: {
      rate: discountedRate,
      p25Rate: formatScaledDown(p25.parsed.digits, p25.parsed.scale, p25.parsed.scale),
      marginBps,
      windowDays,
      sampleCount: validSamples.length,
      basis: `P25 of ${formatCount(validSamples.length)} samples, ${windowDays}d`,
    },
  };
}
