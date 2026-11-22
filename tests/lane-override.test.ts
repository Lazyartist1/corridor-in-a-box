import { describe, expect, it } from "vitest";
import {
  formatLaneResolution,
  resolveManualLaneOverride,
  type LaneOverrideConfig,
} from "../packages/router/src/lane-override";

describe("lane check manual open/closed override (#634)", () => {
  it("uses the probe result when no manual override exists", () => {
    const open = resolveManualLaneOverride({
      domain: "zeam.money",
      runnable: true,
      checkedAt: 1_700_000_000_000,
    });
    expect(open).toMatchObject({
      domain: "zeam.money",
      state: "open",
      source: "probe",
      manual: false,
      probeRunnable: true,
    });
    expect(formatLaneResolution(open)).toContain("[probe]");

    const closed = resolveManualLaneOverride({
      domain: "down.example",
      runnable: false,
      reason: "toml_fetch HTTP 503",
    });
    expect(closed.state).toBe("closed");
    expect(closed.source).toBe("probe");
    expect(closed.manual).toBe(false);
  });

  it("forces a failing probe lane open and records source as manual", () => {
    const overrides: LaneOverrideConfig = {
      "cowrie.exchange": {
        state: "open",
        reason: "signed bilateral contract live ahead of probe update",
        updatedBy: "ops-lead",
        updatedAt: 1_700_000_123_000,
      },
    };
    const res = resolveManualLaneOverride(
      { domain: "Cowrie.Exchange", runnable: false, reason: "sep12 probe pending" },
      overrides,
    );

    expect(res.domain).toBe("cowrie.exchange");
    expect(res.state).toBe("open");
    expect(res.source).toBe("manual");
    expect(res.manual).toBe(true);
    expect(res.probeRunnable).toBe(false);
    expect(res.updatedBy).toBe("ops-lead");
    expect(formatLaneResolution(res)).toContain("open [manual]");
  });

  it("forces a passing probe lane closed via shorthand config and records manual", () => {
    const overrides: LaneOverrideConfig = {
      "zeam.money": "closed",
    };
    const res = resolveManualLaneOverride({ domain: "zeam.money", runnable: true }, overrides);

    expect(res.state).toBe("closed");
    expect(res.source).toBe("manual");
    expect(res.manual).toBe(true);
    expect(res.probeRunnable).toBe(true);
    expect(formatLaneResolution(res)).toContain("closed [manual]");
  });
});
