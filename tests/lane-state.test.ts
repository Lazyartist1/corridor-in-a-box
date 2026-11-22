import { describe, expect, it } from "vitest";
import {
  InMemoryLaneStateStore,
  evaluateLaneLifecycle,
} from "../packages/router/src/lane-state";

describe("lane state 'probably open' -> 'confirmed' (#635)", () => {
  it("starts as 'probably open' when probe passes with zero completed payments", async () => {
    const store = new InMemoryLaneStateStore();
    const res = await evaluateLaneLifecycle({
      domain: "zeam.money",
      probeRunnable: true,
      store,
    });
    expect(res.state).toBe("probably open");
    expect(res.completedPayments).toBe(0);
    expect(res.confirmedAt).toBeUndefined();
  });

  it("transitions to 'confirmed' after the first completed payment and preserves earliest confirmation timestamp", async () => {
    const store = new InMemoryLaneStateStore();

    const before = await evaluateLaneLifecycle({
      domain: "zeam.money",
      probeRunnable: true,
      store,
    });
    expect(before.state).toBe("probably open");

    await store.recordCompletedPayment("zeam.money", 1_700_000_000_000, "tx-1");
    const afterFirst = await evaluateLaneLifecycle({
      domain: "Zeam.Money",
      probeRunnable: true,
      store,
    });
    expect(afterFirst.state).toBe("confirmed");
    expect(afterFirst.source).toBe("payment");
    expect(afterFirst.completedPayments).toBe(1);
    expect(afterFirst.confirmedAt).toBe(1_700_000_000_000);

    await store.recordCompletedPayment("zeam.money", 1_700_000_500_000, "tx-2");
    const afterSecond = await evaluateLaneLifecycle({
      domain: "zeam.money",
      probeRunnable: true,
      store,
    });
    expect(afterSecond.state).toBe("confirmed");
    expect(afterSecond.completedPayments).toBe(2);
    expect(afterSecond.confirmedAt).toBe(1_700_000_000_000);
  });

  it("reports 'closed' if probe fails or manual closed override is set even after prior completion", async () => {
    const store = new InMemoryLaneStateStore();
    await store.recordCompletedPayment("cowrie.exchange", 1_700_000_000_000);

    const probeClosed = await evaluateLaneLifecycle({
      domain: "cowrie.exchange",
      probeRunnable: false,
      store,
    });
    expect(probeClosed.state).toBe("closed");

    const manualClosed = await evaluateLaneLifecycle({
      domain: "cowrie.exchange",
      probeRunnable: true,
      manualOverride: "closed",
      store,
    });
    expect(manualClosed.state).toBe("closed");
    expect(manualClosed.source).toBe("manual");
  });
});
