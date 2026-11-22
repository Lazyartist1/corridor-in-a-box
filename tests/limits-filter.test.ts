import { describe, expect, it } from "vitest";
import { ok } from "@corridor/types";
import {
  CachedCapabilitiesStore,
  filterByLimitsAndFields,
  type LimitsFilterCandidate,
} from "@corridor/router";

const fullCandidate: LimitsFilterCandidate = {
  domain: "good.example",
  protocol: "sep31",
  asset: "USDC",
  capabilities: {
    enabled: true,
    minAmount: "10",
    maxAmount: "5000",
    transactionFields: {
      bank_account_number: { description: "Recipient bank account", optional: false },
      reference: { description: "Optional reference", optional: true },
    },
  },
};

describe("router limits and required-fields filter (#606)", () => {
  it("drops candidates below min_amount with clear reason", async () => {
    const res = await filterByLimitsAndFields([fullCandidate], {
      sourceAmount: { asset: "USDC", amount: "5" },
      suppliedFields: { bank_account_number: "0123456789" },
    });
    expect(res.offered).toHaveLength(0);
    expect(res.dropped[0]?.reason).toBe("amount 5 USDC below min 10");
  });

  it("drops candidates above max_amount with clear reason", async () => {
    const res = await filterByLimitsAndFields([fullCandidate], {
      sourceAmount: { asset: "USDC", amount: "6000" },
      suppliedFields: { bank_account_number: "0123456789" },
    });
    expect(res.offered).toHaveLength(0);
    expect(res.dropped[0]?.reason).toBe("amount 6000 USDC above max 5000");
  });

  it("drops candidates missing a required transaction field while permitting missing optional fields", async () => {
    const missingReq = await filterByLimitsAndFields([fullCandidate], {
      sourceAmount: { asset: "USDC", amount: "100" },
      suppliedFields: {},
    });
    expect(missingReq.offered).toHaveLength(0);
    expect(missingReq.dropped[0]?.reason).toBe("missing required field: bank_account_number");

    const okRes = await filterByLimitsAndFields([fullCandidate], {
      sourceAmount: { asset: "USDC", amount: "100" },
      suppliedFields: { bank_account_number: "0123456789" },
    });
    expect(okRes.dropped).toHaveLength(0);
    expect(okRes.offered).toHaveLength(1);
    expect(okRes.offered[0]?.domain).toBe("good.example");
  });

  it("caches /info lookups per domain and asset until TTL expires", async () => {
    let clock = 1_700_000_000_000;
    let calls = 0;
    const cache = new CachedCapabilitiesStore({ ttlMs: 60_000, now: () => clock });
    const candidate: LimitsFilterCandidate = {
      domain: "cached.example",
      protocol: "sep31",
      asset: "USDC",
      fetchInfo: async () => {
        calls += 1;
        return ok({ enabled: true, minAmount: "10", maxAmount: "1000" });
      },
    };

    await filterByLimitsAndFields(
      [candidate],
      { sourceAmount: { asset: "USDC", amount: "100" } },
      { cache },
    );
    await filterByLimitsAndFields(
      [candidate],
      { sourceAmount: { asset: "USDC", amount: "200" } },
      { cache },
    );
    expect(calls).toBe(1);

    clock += 60_001;
    await filterByLimitsAndFields(
      [candidate],
      { sourceAmount: { asset: "USDC", amount: "200" } },
      { cache },
    );
    expect(calls).toBe(2);
  });
});
