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
    // 1912 samples spread evenly across exactly 7 days (the default window and minimum span)
    const history: RateSample[] = Array.from({ length: 1912 }, (_, index) => ({
      // Rates cycle monotonically cleanly: quartile boundary falls cleanly on 100.00
      rate: index < 478 ? "99.00" : index < 956 ? "100.00" : "102.00",
      timestampMs: nowMs - Math.round((index * 7 * 86_400_000) / 1911),
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

    // p25Index = floor(0.25 * 1911) = 477 => 99.00; minus default 50 bps (0.5%) = 98.505
    expect(outcome.label).toBe("estimated");
    expect(outcome.price).toEqual({
      p25Rate: "99",
      rate: "98.505",
      marginBps: 50,
      windowDays: 7,
      sampleCount: 1912,
      basis: "P25 of 1,912 samples, 7d",
    });
    expect(outcome.estimatedDestAmount).toEqual({
      asset: "NGN",
      amount: "24626.25",
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
      reason: "dropped: unpriceable (10 of 100 samples in 7d window)",
      sampleCount: 10,
      minSamples: 100,
      minSpanDays: 7,
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
        minEstimateSpanDays: 0,
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
        minEstimateSamples: 24,
        minEstimateSpanDays: 4,
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

  it("drops the candidate when enough samples cover less than the minimum history", () => {
    // 150 samples, 30 minutes apart: plenty of samples, but only ~3.1 days of history.
    const history = makeSamples(150, nowMs, 0.5, () => "1500.00");

    const outcome = buildEstimatedOption({
      receivingDomain: "short-span.example",
      sourceAmount: { asset: "USDC", amount: "100" },
      destAsset: "NGN",
      history,
      nowMs,
    });

    expect(outcome).toEqual({
      status: "dropped",
      receivingDomain: "short-span.example",
      reason: "dropped: unpriceable (history covers 3.1d of 7d needed)",
      sampleCount: 150,
      minSamples: 100,
      minSpanDays: 7,
      windowDays: 7,
    });
  });

  it("offers a price at the RFC 0004 D3 defaults: 100 samples spanning 7 days, 50 bps margin", () => {
    const history: RateSample[] = Array.from({ length: 100 }, (_, index) => ({
      rate: "100.00",
      timestampMs: nowMs - Math.round((index * 7 * 86_400_000) / 99),
    }));

    const outcome = buildEstimatedOption({
      receivingDomain: "defaults.example",
      sourceAmount: { asset: "USDC", amount: "10" },
      destAsset: "NGN",
      history,
      nowMs,
    });

    expect(outcome.status).toBe("offered");
    if (outcome.status === "offered") {
      expect(outcome.price).toMatchObject({
        p25Rate: "100",
        rate: "99.5",
        marginBps: 50,
        windowDays: 7,
        sampleCount: 100,
      });
    }
  });

  it("prices a realistic 15-minute series that does not start on the window edge, at the defaults", () => {
    // A collector running for 30 days, sampling every 15 minutes, with the last sample taken
    // 7 minutes ago: nothing sits exactly on the window start or on `now`. The in-window samples
    // span about 6d 23h 45m, which the old in-window check rejected for every anchor.
    const fifteenMin = 15 * 60_000;
    const lastSampleMs = nowMs - 7 * 60_000;
    const history: RateSample[] = Array.from(
      { length: (30 * 86_400_000) / fifteenMin },
      (_, i) => ({
        rate: "100.00",
        timestampMs: lastSampleMs - i * fifteenMin,
      }),
    );

    const outcome = buildEstimatedOption({
      receivingDomain: "collector.example",
      sourceAmount: { asset: "USDC", amount: "10" },
      destAsset: "NGN",
      history,
      nowMs,
    });

    expect(outcome.status).toBe("offered");
    if (outcome.status === "offered") {
      // 7 days of 15-minute samples inside the window: 672 of them, all well over the 100 minimum.
      expect(outcome.price.sampleCount).toBe(672);
      expect(outcome.price.rate).toBe("99.5");
    }
  });

  it("measures the history over all supplied samples, not just the window", () => {
    // A 1-day window: 100 samples in the last day, plus older samples reaching 8 days back.
    const recent: RateSample[] = Array.from({ length: 100 }, (_, index) => ({
      rate: "100.00",
      timestampMs: nowMs - Math.round((index * 86_400_000) / 100),
    }));
    const older = makeSamples(8, nowMs - 86_400_000, 24, () => "100.00");
    const request = {
      receivingDomain: "one-day.example",
      sourceAmount: { asset: "USDC", amount: "10" },
      destAsset: "NGN",
      policy: { estimateWindowDays: 1 },
      nowMs,
    } as const;

    expect(buildEstimatedOption({ ...request, history: [...recent, ...older] }).status).toBe(
      "offered",
    );
    // The same window with only one day of history behind it is dropped at the 7-day default.
    expect(buildEstimatedOption({ ...request, history: recent })).toMatchObject({
      status: "dropped",
      reason: "dropped: unpriceable (history covers 0.9d of 7d needed)",
    });
  });

  it("ignores unparseable and future samples when measuring the history", () => {
    const inWindow: RateSample[] = Array.from({ length: 100 }, (_, index) => ({
      rate: "100.00",
      timestampMs: nowMs - Math.round((index * 3 * 86_400_000) / 99),
    }));
    const outcome = buildEstimatedOption({
      receivingDomain: "junk.example",
      sourceAmount: { asset: "USDC", amount: "10" },
      destAsset: "NGN",
      history: [
        ...inWindow,
        { rate: "not-a-rate", timestampMs: nowMs - 20 * 86_400_000 },
        { rate: "0", timestampMs: nowMs - 20 * 86_400_000 },
        { rate: "100.00", timestampMs: Number.NaN },
      ],
      nowMs,
    });

    expect(outcome).toMatchObject({
      status: "dropped",
      reason: "dropped: unpriceable (history covers 3.0d of 7d needed)",
    });
  });

  it("rejects a negative or non-finite minEstimateSpanDays", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildEstimatedOption({
          receivingDomain: "bad.example",
          sourceAmount: { asset: "USDC", amount: "10" },
          destAsset: "NGN",
          history: [],
          policy: { minEstimateSpanDays: bad },
          nowMs,
        }),
      ).toThrow(RangeError);
    }
  });
});
