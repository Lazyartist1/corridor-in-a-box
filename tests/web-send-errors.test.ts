import { describe, expect, it } from "vitest";
import { describeSendError, sendErrorKindForCode } from "../web/lib/send-errors";

describe("no routes", () => {
  const view = describeSendError({ kind: "no_routes" });

  it("says no route was found and offers to change the payment", () => {
    expect(view.kind).toBe("no_routes");
    expect(view.title).toBe("No routes available");
    expect(view.message).toContain("No route was found");
    expect(view.action).toBe("Change the payment");
  });

  it("has nothing to list", () => {
    expect(view.details).toEqual([]);
  });
});

describe("all routes dropped", () => {
  const view = describeSendError({
    kind: "all_routes_dropped",
    dropped: [
      { route: "Anchor A", reason: "amount is above its limit" },
      { route: "Anchor B", reason: "it is not attested" },
    ],
  });

  it("lists every dropped route with its reason", () => {
    expect(view.kind).toBe("all_routes_dropped");
    expect(view.details).toEqual([
      "Anchor A: amount is above its limit",
      "Anchor B: it is not attested",
    ]);
  });

  it("is a different screen from no routes", () => {
    expect(view.title).not.toBe(describeSendError({ kind: "no_routes" }).title);
  });

  it("reads as no routes when the list of reasons is empty", () => {
    const empty = describeSendError({ kind: "all_routes_dropped", dropped: [] });
    expect(empty.kind).toBe("no_routes");
  });
});

describe("quote expired", () => {
  const view = describeSendError({ kind: "quote_expired" });

  it("says the price expired and offers a new one", () => {
    expect(view.kind).toBe("quote_expired");
    expect(view.title).toBe("The locked price expired");
    expect(view.action).toBe("Get a new price");
  });

  it("is chosen for the service's quote expiry codes", () => {
    expect(sendErrorKindForCode("QUOTE_EXPIRED")).toBe("quote_expired");
    expect(sendErrorKindForCode("PRESETTLE_QUOTE_WINDOW")).toBe("quote_expired");
  });
});

describe("payment failed", () => {
  it("words the failure from its code", () => {
    const view = describeSendError({ kind: "payment_failed", code: "SETTLEMENT_TIMEOUT" });
    expect(view.kind).toBe("payment_failed");
    expect(view.message).toContain("did not confirm the payment in time");
    expect(view.details).toContain("Error code: SETTLEMENT_TIMEOUT");
    expect(view.action).toBe("Start a new payment");
  });

  it("falls back to a general message for a code it has no wording for", () => {
    const view = describeSendError({ kind: "payment_failed", code: "SOMETHING_NEW" });
    expect(view.message).toBe("Something went wrong while sending the payment.");
    expect(describeSendError({ kind: "payment_failed" }).message).toBe(view.message);
  });

  it("says when the funds were returned and shows the transaction", () => {
    const view = describeSendError({
      kind: "payment_failed",
      code: "SETTLEMENT_FAILED",
      state: "refunded",
      stellarTxHash: "abc123",
    });
    expect(view.details).toContain("The test funds were returned to the sender.");
    expect(view.details).toContain("Stellar transaction: abc123");
  });

  it("does not claim a refund for any other state", () => {
    const view = describeSendError({ kind: "payment_failed", state: "failed" });
    expect(view.details.join(" ")).not.toContain("returned");
  });

  it("is chosen for every code that is not a quote expiry", () => {
    expect(sendErrorKindForCode("SETTLEMENT_FAILED")).toBe("payment_failed");
    expect(sendErrorKindForCode(undefined)).toBe("payment_failed");
  });
});
