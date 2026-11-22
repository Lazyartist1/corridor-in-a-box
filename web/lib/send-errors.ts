// What the testnet send app says when a payment cannot go ahead.
//
// Four situations each get their own screen: no routes were found, every route
// was dropped, the locked price expired, and the payment failed. This module
// turns each into the words the screen shows, so the wording is decided in one
// place and unit-tested from the repo's root test suite.
//
// Pure and self-contained on purpose (no imports from the rest of web/,
// structural types only), like run-status.ts.
//
// Raw error messages are never shown. The service puts anchor URLs and upstream
// response bodies in them, and a sender has no use for either, so the failed
// payment screen is worded from the error code alone.

export type SendErrorKind =
  | "no_routes"
  | "all_routes_dropped"
  | "quote_expired"
  | "payment_failed";

/** A route the planner considered and refused, with the reason it gave. */
export interface DroppedRoute {
  /** A name the sender recognises, such as the receiving anchor. */
  route: string;
  reason: string;
}

export type SendErrorInput =
  | { kind: "no_routes" }
  | { kind: "all_routes_dropped"; dropped: readonly DroppedRoute[] }
  | { kind: "quote_expired" }
  | {
      kind: "payment_failed";
      /** The service's error code, for example SETTLEMENT_FAILED. */
      code?: string;
      /** The run's final state, for example refunded. */
      state?: string;
      stellarTxHash?: string;
    };

/** What a screen renders. */
export interface SendErrorView {
  kind: SendErrorKind;
  title: string;
  message: string;
  /** One line per dropped route or per fact worth showing, possibly empty. */
  details: string[];
  /** The one thing the sender can do next, as button text. */
  action: string;
}

/** Service codes that mean the locked price ran out before settlement. */
const QUOTE_EXPIRED_CODES: ReadonlySet<string> = new Set([
  "QUOTE_EXPIRED",
  "PRESETTLE_QUOTE_WINDOW",
]);

/**
 * Which screen a service error code belongs on. Quote expiry has its own screen
 * because the fix is different: the sender only needs a new price.
 */
export function sendErrorKindForCode(code: string | undefined): SendErrorKind {
  return code !== undefined && QUOTE_EXPIRED_CODES.has(code)
    ? "quote_expired"
    : "payment_failed";
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  SETTLEMENT_FAILED: "The payment could not be submitted to the Stellar network.",
  SETTLEMENT_TIMEOUT: "The receiving anchor did not confirm the payment in time.",
  RECONCILE_STALLED: "The receiving anchor stopped reporting progress on the payment.",
  ANCHOR_UNAVAILABLE: "The receiving anchor could not be reached.",
  KYC_REJECTED: "The receiving anchor did not accept the sender or recipient details.",
  PRESETTLE_INSUFFICIENT_FUNDS:
    "The test account does not hold enough funds for this payment.",
};

const GENERIC_FAILURE = "Something went wrong while sending the payment.";

function paymentFailed(
  input: Extract<SendErrorInput, { kind: "payment_failed" }>,
): SendErrorView {
  const details: string[] = [];
  if (input.state === "refunded") {
    details.push("The test funds were returned to the sender.");
  }
  if (input.stellarTxHash) {
    details.push(`Stellar transaction: ${input.stellarTxHash}`);
  }
  if (input.code) {
    details.push(`Error code: ${input.code}`);
  }
  return {
    kind: "payment_failed",
    title: "The payment failed",
    message: (input.code && FAILURE_TEXT[input.code]) || GENERIC_FAILURE,
    details,
    action: "Start a new payment",
  };
}

export function describeSendError(input: SendErrorInput): SendErrorView {
  switch (input.kind) {
    case "no_routes":
      return {
        kind: "no_routes",
        title: "No routes available",
        message:
          "No route was found for this amount and destination. Try a different amount or destination.",
        details: [],
        action: "Change the payment",
      };

    case "all_routes_dropped": {
      // A list with nothing in it explains nothing, so it reads as no routes.
      if (input.dropped.length === 0) return describeSendError({ kind: "no_routes" });
      return {
        kind: "all_routes_dropped",
        title: "Every route was ruled out",
        message: "Routes were found, but none could be used. Here is why each was dropped.",
        details: input.dropped.map((d) => `${d.route}: ${d.reason}`),
        action: "Change the payment",
      };
    }

    case "quote_expired":
      return {
        kind: "quote_expired",
        title: "The locked price expired",
        message:
          "The price was held for a short time and has run out. Get a new price to continue.",
        details: [],
        action: "Get a new price",
      };

    case "payment_failed":
      return paymentFailed(input);
  }
}
