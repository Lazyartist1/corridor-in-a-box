import { describe, expect, it } from "vitest";
import {
  findStale,
  DEFAULT_MAX_STALENESS_LEDGERS,
  type StalenessRecord,
} from "@corridor/registry";

describe("findStale", () => {
  const THRESHOLD = 34_560; // 2 days at 5s/ledger

  it("returns no findings when all domains are fresh", () => {
    const records: StalenessRecord[] = [
      { domain: "cowrie.exchange", staleness: 100 },
      { domain: "testanchor.stellar.org", staleness: 1000 },
      { domain: "stellar.org", staleness: THRESHOLD },
    ];
    const stale = findStale(records, THRESHOLD);
    expect(stale).toEqual([]);
  });

  it("flags domains older than threshold as stale", () => {
    const records: StalenessRecord[] = [
      { domain: "fresh.example", staleness: 500 },
      { domain: "old.example", staleness: THRESHOLD + 1 },
      { domain: "ancient.example", staleness: 100_000 },
    ];
    const stale = findStale(records, THRESHOLD);
    expect(stale).toEqual([
      { domain: "old.example", reason: "stale", staleness: THRESHOLD + 1 },
      { domain: "ancient.example", reason: "stale", staleness: 100_000 },
    ]);
  });

  it("flags domains never attested (undefined or null) as never-attested", () => {
    const records: StalenessRecord[] = [
      { domain: "attested.example", staleness: 200 },
      { domain: "unattested-undefined.example", staleness: undefined },
      { domain: "unattested-null.example", staleness: null },
    ];
    const stale = findStale(records, THRESHOLD);
    expect(stale).toEqual([
      { domain: "unattested-undefined.example", reason: "never-attested" },
      { domain: "unattested-null.example", reason: "never-attested" },
    ]);
  });

  it("handles a mix of fresh, stale, and never-attested domains in order", () => {
    const records: StalenessRecord[] = [
      { domain: "a.example", staleness: 10 },
      { domain: "b.example", staleness: null },
      { domain: "c.example", staleness: THRESHOLD + 500 },
      { domain: "d.example", staleness: THRESHOLD },
      { domain: "e.example", staleness: undefined },
    ];
    const stale = findStale(records, THRESHOLD);
    expect(stale).toEqual([
      { domain: "b.example", reason: "never-attested" },
      { domain: "c.example", reason: "stale", staleness: THRESHOLD + 500 },
      { domain: "e.example", reason: "never-attested" },
    ]);
  });

  it("accepts a Record<string, number | null | undefined> map", () => {
    const map = {
      "fresh.example": 50,
      "stale.example": THRESHOLD + 200,
      "unattested.example": null,
    };
    const stale = findStale(map, THRESHOLD);
    expect(stale).toEqual([
      { domain: "stale.example", reason: "stale", staleness: THRESHOLD + 200 },
      { domain: "unattested.example", reason: "never-attested" },
    ]);
  });

  it("defaults threshold to DEFAULT_MAX_STALENESS_LEDGERS", () => {
    expect(DEFAULT_MAX_STALENESS_LEDGERS).toBe(34_560);
    const records: StalenessRecord[] = [
      { domain: "at-default.example", staleness: DEFAULT_MAX_STALENESS_LEDGERS },
      { domain: "past-default.example", staleness: DEFAULT_MAX_STALENESS_LEDGERS + 1 },
    ];
    const stale = findStale(records);
    expect(stale).toEqual([
      {
        domain: "past-default.example",
        reason: "stale",
        staleness: DEFAULT_MAX_STALENESS_LEDGERS + 1,
      },
    ]);
  });
});
