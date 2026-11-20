import { describe, expect, it } from "vitest";
import { buildEstimatedOption, type RateSample } from "@corridor/router";

function makeSamples(
  count: number,
  nowMs: number,
  stepHours: number,
  rateForIndex: (index: number) => string,
): RateSample[] {
  return Array.from({ length: count }, (_, index) => ({
    rate: rateForIndex(index),
    timestampMs: nowMs - index * stepHours * 3_600_000,
  }));
}

describe("buildEstimatedOption", () => {
  const nowMs = Date.UTC(2026, 10, 20, 9, 0, 0);

  it("computes P25 minus margin with exact BigInt math and populates price.basis", () => {
    // 1912 samples inside 7d window (spaced every 5 minutes ~= 6.64 days)
    const history: RateSample[] = Array.from({ length: 1912 }, (_, index) => ({
      // Rates cycle monotonically cleanly: quartile boundary falls cleanly on 100.00
      rate: index < 478 ? "99.00" : index < 956 ? "100.00" : "102.00",
      timestampMs: nowMs - index * 5 * 60_000,
    }));
    // Stale sample from 10 days ago should be excluded from default 7d window
    history.push({ rate: "50.00", timestampMs: nowMs - 10 * 86_400_000 });

    const outcome = buildEstimatedOption({
      receivingDomain: "cowrie.example",
      sourceAmount: { asset: "USDC", amount: "250.00" },
      destAsset: "NGN",
      history,
      nowMs,
    });

    expect(outcome.status).toBe("offered");
    if (outcome.status !== "offered") {
      throw new Error("Expected offered outcome");
    }

    // p25Index = floor(0.25 * 1911) = 477 => 99.00; minus default 100 bps (1%) = 98.01
    expect(outcome.label).toBe("estimated");
    expect(outcome.price).toEqual({
      p25Rate: "99",
      rate: "98.01",
      marginBps: 100,
      windowDays: 7,
      sampleCount: 1912,
      basis: "P25 of 1,912 samples, 7d",
    });
    expect(outcome.estimatedDestAmount).toEqual({
      asset: "NGN",
      amount: "24502.5",
    });
  });

  it("drops the candidate as unpriceable when recent samples are below minimum threshold", () => {
    const history = makeSamples(10, nowMs, 2, () => "1500.00");

    const outcome = buildEstimatedOption({
      receivingDomain: "thin.example",
      sourceAmount: { asset: "USDC", amount: "100" },
      destAsset: "NGN",
      history,
      nowMs,
    });

    expect(outcome).toEqual({
      status: "dropped",
      receivingDomain: "thin.example",
      reason: "dropped: unpriceable (10 of 20 samples in 7d window)",
      sampleCount: 10,
      minSamples: 20,
      windowDays: 7,
    });
  });

  it("respects policy overrides for estimateWindowDays, estimateMarginBps, and minEstimateSamples", () => {
    // 4 samples within 24h, plus 20 samples 2-5 days ago
    const recent = makeSamples(
      4,
      nowMs,
      4,
      (i) => ["100.00", "104.00", "108.00", "112.00"][i] ?? "100.00",
    );
    const older = makeSamples(20, nowMs - 2 * 86_400_000, 3, () => "90.00");

    const oneDayOutcome = buildEstimatedOption({
      receivingDomain: "custom.example",
      sourceAmount: { asset: "USDC", amount: "10.00" },
      destAsset: "EURC",
      history: [...recent, ...older],
      policy: {
        estimateWindowDays: 1,
        estimateMarginBps: 250,
        minEstimateSamples: 4,
      },
      nowMs,
    });

    expect(oneDayOutcome.status).toBe("offered");
    if (oneDayOutcome.status !== "offered") {
      throw new Error("Expected offered outcome");
    }
    // 4 recent samples [100, 104, 108, 112], p25Index = floor(0.25 * 3) = 0 => 100
    // 250 bps margin => 100 * 0.975 = 97.5
    expect(oneDayOutcome.price).toEqual({
      p25Rate: "100",
      rate: "97.5",
      marginBps: 250,
      windowDays: 1,
      sampleCount: 4,
      basis: "P25 of 4 samples, 1d",
    });
    expect(oneDayOutcome.estimatedDestAmount).toEqual({
      asset: "EURC",
      amount: "975",
    });

    // Compare against 7-day window where the 20 older 90.00 samples pull P25 down
    const sevenDayOutcome = buildEstimatedOption({
      receivingDomain: "custom.example",
      sourceAmount: { asset: "USDC", amount: "10.00" },
      destAsset: "EURC",
      history: [...recent, ...older],
      policy: {
        estimateWindowDays: 7,
        estimateMarginBps: 0,
      },
      nowMs,
    });

    expect(sevenDayOutcome.status).toBe("offered");
    if (sevenDayOutcome.status === "offered") {
      expect(sevenDayOutcome.price.p25Rate).toBe("90");
      expect(sevenDayOutcome.price.sampleCount).toBe(24);
      expect(sevenDayOutcome.price.basis).toBe("P25 of 24 samples, 7d");
    }
  });
});
