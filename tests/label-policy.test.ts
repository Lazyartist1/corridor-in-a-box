import { describe, expect, it } from "vitest";
import { filterOptionsByAllowedLabels, type LabelledRouteOption } from "@corridor/router";

describe("filterOptionsByAllowedLabels", () => {
  const sampleOptions: LabelledRouteOption[] = [
    {
      receivingDomain: "cowrie.example",
      label: "locked",
      reasons: ["locked for 60 s"],
    },
    {
      receivingDomain: "mykobo.example",
      label: "indicative",
      reasons: ["indicative rate"],
    },
    {
      receivingDomain: "zeam.example",
      label: "estimated",
      reasons: ["estimated from 1,912 samples over 7 d"],
    },
  ];

  it("allows all labels when policy or policy.allowedLabels is omitted", () => {
    expect(filterOptionsByAllowedLabels(sampleOptions)).toEqual({
      allowed: sampleOptions,
      dropped: [],
    });
    expect(filterOptionsByAllowedLabels(sampleOptions, {})).toEqual({
      allowed: sampleOptions,
      dropped: [],
    });
  });

  it("drops indicative and estimated options under a locked-only policy", () => {
    const result = filterOptionsByAllowedLabels(sampleOptions, {
      allowedLabels: ["locked"],
    });

    expect(result.allowed.map((o) => o.receivingDomain)).toEqual(["cowrie.example"]);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]).toMatchObject({
      option: { receivingDomain: "mykobo.example", label: "indicative" },
      status: "dropped",
      reason: "dropped: label indicative excluded by policy (allowed: locked)",
      reasons: [
        "indicative rate",
        "dropped: label indicative excluded by policy (allowed: locked)",
      ],
    });
    expect(result.dropped[1]).toMatchObject({
      option: { receivingDomain: "zeam.example", label: "estimated" },
      status: "dropped",
      reason: "dropped: label estimated excluded by policy (allowed: locked)",
    });
  });

  it("keeps locked and indicative options while dropping estimated under a locked+indicative policy", () => {
    const result = filterOptionsByAllowedLabels(sampleOptions, {
      allowedLabels: ["locked", "indicative"],
    });

    expect(result.allowed.map((o) => o.receivingDomain)).toEqual([
      "cowrie.example",
      "mykobo.example",
    ]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({
      option: { receivingDomain: "zeam.example", label: "estimated" },
      status: "dropped",
      reason: "dropped: label estimated excluded by policy (allowed: locked, indicative)",
    });
  });

  it("fails closed when allowedLabels is an empty list", () => {
    const result = filterOptionsByAllowedLabels(sampleOptions, {
      allowedLabels: [],
    });

    expect(result.allowed).toEqual([]);
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped[0]?.reason).toBe(
      "dropped: label locked excluded (no price labels allowed by policy)",
    );
  });
});
