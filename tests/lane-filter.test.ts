import { describe, expect, it } from "vitest";
import {
  filterCandidatesByLaneState,
  type LaneStateDecision,
} from "../packages/router/src/lane-filter";

describe("filterCandidatesByLaneState (#636)", () => {
  it("drops closed lanes and labels probably-open candidates while keeping confirmed ones", async () => {
    const candidates = [
      { domain: "confirmed.example", protocol: "sep31" },
      { domain: "unproven.example", protocol: "sep31" },
      { domain: "halted.example", protocol: "sep6" },
    ];

    const states: Record<string, LaneStateDecision> = {
      "confirmed.example": { state: "confirmed" },
      "unproven.example": { state: "probably open" },
      "halted.example": { state: "closed", reason: "manual close" },
    };

    const result = await filterCandidatesByLaneState(
      candidates,
      async (domain) => states[domain] ?? { state: "closed" },
    );

    expect(result.kept).toHaveLength(2);
    expect(result.kept[0]).toMatchObject({
      domain: "confirmed.example",
      laneState: "confirmed",
    });
    expect(result.kept[0]?.laneLabel).toBeUndefined();

    expect(result.kept[1]).toMatchObject({
      domain: "unproven.example",
      laneState: "probably open",
      laneLabel: "probably open",
      reason: "probably open",
    });

    expect(result.dropped).toEqual([
      {
        domain: "halted.example",
        receivingDomain: "halted.example",
        protocol: "sep6",
        dropped: true,
        laneState: "closed",
        reason: "dropped: lane closed (manual close)",
      },
    ]);
  });

  it("drops unknown candidates that default to closed", async () => {
    const res = await filterCandidatesByLaneState([{ domain: "unknown.example" }], () => ({
      state: "closed",
    }));
    expect(res.kept).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("dropped: lane closed");
  });
});
