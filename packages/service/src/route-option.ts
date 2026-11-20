import * as crypto from "node:crypto";
import {
  constantTimeEqual,
  err,
  isSettleableAmount,
  isValidAmount,
  ok,
  type Money,
  type Outcome,
} from "@corridor/types";

export interface ChosenRouteOptionQuote {
  id: string;
  sourceAmount: Money;
  destAmount: Money;
  price: string;
  fee?: Money;
  expiresAt: number;
}

export interface ChosenRouteOptionPayload {
  corridorId: string;
  receivingDomain: string;
  protocol: "sep31" | "sep6" | "wallet";
  label: "locked" | "indicative" | "estimated";
  sourceAmount: Money;
  expiresAt: number;
  quote?: ChosenRouteOptionQuote;
}

export interface ChosenRouteOption extends ChosenRouteOptionPayload {
  signature: string;
}

export interface RouteOptionRejection {
  code: "UNCONFIGURED" | "INVALID_SIGNATURE" | "EXPIRED" | "MISMATCH" | "INVALID_LOCKED_QUOTE";
  status: 400 | 409 | 422;
  message: string;
}

const OPTION_FIELDS = new Set([
  "corridorId",
  "receivingDomain",
  "protocol",
  "label",
  "sourceAmount",
  "expiresAt",
  "quote",
  "signature",
]);

const QUOTE_FIELDS = new Set([
  "id",
  "sourceAmount",
  "destAmount",
  "price",
  "fee",
  "expiresAt",
]);

const MONEY_FIELDS = new Set(["asset", "amount"]);
const PROTOCOLS = new Set(["sep31", "sep6", "wallet"]);
const LABELS = new Set(["locked", "indicative", "estimated"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkBoundedString(
  v: unknown,
  field: string,
  maxLen: number,
): Outcome<string, string> {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) {
    return err(`${field}: must be a non-empty string up to ${maxLen} chars`);
  }
  return ok(v);
}

function parseMoney(
  v: unknown,
  field: string,
  requirePositive: boolean,
): Outcome<Money, string> {
  if (!isPlainObject(v)) {
    return err(`${field}: must be an object`);
  }
  for (const key of Object.keys(v)) {
    if (!MONEY_FIELDS.has(key)) {
      return err(`${field}: unknown property ${key}`);
    }
  }
  const asset = checkBoundedString(v.asset, `${field}.asset`, 64);
  if (!asset.ok) return asset;
  if (typeof v.amount !== "string") {
    return err(`${field}.amount: must be a string`);
  }
  const valid = requirePositive ? isSettleableAmount(v.amount) : isValidAmount(v.amount);
  if (!valid) {
    return err(`${field}.amount: invalid decimal amount`);
  }
  return ok({ asset: asset.value, amount: v.amount });
}

function canonicalizeMoney(m: Money) {
  return { asset: m.asset, amount: m.amount };
}

function canonicalizePayload(payload: ChosenRouteOptionPayload): string {
  return JSON.stringify({
    corridorId: payload.corridorId,
    receivingDomain: payload.receivingDomain,
    protocol: payload.protocol,
    label: payload.label,
    sourceAmount: canonicalizeMoney(payload.sourceAmount),
    expiresAt: payload.expiresAt,
    ...(payload.quote
      ? {
          quote: {
            id: payload.quote.id,
            sourceAmount: canonicalizeMoney(payload.quote.sourceAmount),
            destAmount: canonicalizeMoney(payload.quote.destAmount),
            price: payload.quote.price,
            ...(payload.quote.fee ? { fee: canonicalizeMoney(payload.quote.fee) } : {}),
            expiresAt: payload.quote.expiresAt,
          },
        }
      : {}),
  });
}

function computeHmac(payload: ChosenRouteOptionPayload, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(canonicalizePayload(payload))
    .digest("hex");
}

/**
 * Signs a chosen route option payload with HMAC-SHA256 so a client can submit
 * it back to `POST /payments` without permitting rate, expiry, or anchor
 * tampering.
 */
export function signRouteOption(
  payload: ChosenRouteOptionPayload,
  secret: string,
): ChosenRouteOption {
  if (!secret) {
    throw new Error("routeOptionSecret must be non-empty");
  }
  return {
    corridorId: payload.corridorId,
    receivingDomain: payload.receivingDomain,
    protocol: payload.protocol,
    label: payload.label,
    sourceAmount: { ...payload.sourceAmount },
    expiresAt: payload.expiresAt,
    ...(payload.quote ? { quote: payload.quote } : {}),
    signature: computeHmac(payload, secret),
  };
}

/**
 * Parses and validates the JSON shape of an untrusted `routeOption` request field.
 */
export function parseChosenRouteOption(raw: unknown): Outcome<ChosenRouteOption, string> {
  if (!isPlainObject(raw)) {
    return err("routeOption: must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!OPTION_FIELDS.has(key)) {
      return err(`routeOption: unknown property ${key}`);
    }
  }

  const corridorId = checkBoundedString(raw.corridorId, "routeOption.corridorId", 128);
  if (!corridorId.ok) return corridorId;

  const receivingDomain = checkBoundedString(
    raw.receivingDomain,
    "routeOption.receivingDomain",
    255,
  );
  if (!receivingDomain.ok) return receivingDomain;

  if (typeof raw.protocol !== "string" || !PROTOCOLS.has(raw.protocol)) {
    return err("routeOption.protocol: must be sep31, sep6, or wallet");
  }
  if (typeof raw.label !== "string" || !LABELS.has(raw.label)) {
    return err("routeOption.label: must be locked, indicative, or estimated");
  }

  const sourceAmount = parseMoney(raw.sourceAmount, "routeOption.sourceAmount", true);
  if (!sourceAmount.ok) return sourceAmount;

  if (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) {
    return err("routeOption.expiresAt: must be a finite epoch ms number");
  }

  const signature = checkBoundedString(raw.signature, "routeOption.signature", 256);
  if (!signature.ok) return signature;

  let quote: ChosenRouteOptionQuote | undefined;
  if (raw.quote !== undefined) {
    if (!isPlainObject(raw.quote)) {
      return err("routeOption.quote: must be an object");
    }
    for (const key of Object.keys(raw.quote)) {
      if (!QUOTE_FIELDS.has(key)) {
        return err(`routeOption.quote: unknown property ${key}`);
      }
    }
    const id = checkBoundedString(raw.quote.id, "routeOption.quote.id", 128);
    if (!id.ok) return id;

    const qSource = parseMoney(raw.quote.sourceAmount, "routeOption.quote.sourceAmount", true);
    if (!qSource.ok) return qSource;

    const qDest = parseMoney(raw.quote.destAmount, "routeOption.quote.destAmount", true);
    if (!qDest.ok) return qDest;

    if (typeof raw.quote.price !== "string" || !isSettleableAmount(raw.quote.price)) {
      return err("routeOption.quote.price: must be a positive decimal string");
    }

    let fee: Money | undefined;
    if (raw.quote.fee !== undefined) {
      const parsedFee = parseMoney(raw.quote.fee, "routeOption.quote.fee", false);
      if (!parsedFee.ok) return parsedFee;
      fee = parsedFee.value;
    }

    if (typeof raw.quote.expiresAt !== "number" || !Number.isFinite(raw.quote.expiresAt)) {
      return err("routeOption.quote.expiresAt: must be a finite epoch ms number");
    }

    quote = {
      id: id.value,
      sourceAmount: qSource.value,
      destAmount: qDest.value,
      price: raw.quote.price,
      ...(fee ? { fee } : {}),
      expiresAt: raw.quote.expiresAt,
    };
  }

  return ok({
    corridorId: corridorId.value,
    receivingDomain: receivingDomain.value,
    protocol: raw.protocol as ChosenRouteOptionPayload["protocol"],
    label: raw.label as ChosenRouteOptionPayload["label"],
    sourceAmount: sourceAmount.value,
    expiresAt: raw.expiresAt,
    ...(quote ? { quote } : {}),
    signature: signature.value,
  });
}

/**
 * Verifies cryptographic authenticity, expiration, and payment intent binding
 * for a caller-submitted route option.
 */
export function verifyRouteOption(
  option: ChosenRouteOption,
  secret: string | undefined,
  expected: {
    corridorId: string;
    sourceAmount: Money;
    receivingDomain?: string;
    nowMs: number;
  },
): Outcome<ChosenRouteOptionPayload, RouteOptionRejection> {
  if (!secret) {
    return err({
      code: "UNCONFIGURED",
      status: 422,
      message: "route option pinning is not configured on this service",
    });
  }

  const payload: ChosenRouteOptionPayload = {
    corridorId: option.corridorId,
    receivingDomain: option.receivingDomain,
    protocol: option.protocol,
    label: option.label,
    sourceAmount: option.sourceAmount,
    expiresAt: option.expiresAt,
    ...(option.quote ? { quote: option.quote } : {}),
  };

  const expectedSig = computeHmac(payload, secret);
  const presentedSig = option.signature.toLowerCase();
  if (!constantTimeEqual(presentedSig, expectedSig)) {
    return err({
      code: "INVALID_SIGNATURE",
      status: 400,
      message: "routeOption signature is invalid",
    });
  }

  if (option.expiresAt <= expected.nowMs) {
    return err({
      code: "EXPIRED",
      status: 409,
      message: "chosen route option has expired",
    });
  }

  if (option.corridorId !== expected.corridorId) {
    return err({
      code: "MISMATCH",
      status: 422,
      message: "routeOption corridorId does not match request corridorId",
    });
  }

  if (
    option.sourceAmount.asset !== expected.sourceAmount.asset ||
    option.sourceAmount.amount !== expected.sourceAmount.amount
  ) {
    return err({
      code: "MISMATCH",
      status: 422,
      message: "routeOption sourceAmount does not match request sourceAmount",
    });
  }

  if (expected.receivingDomain && option.receivingDomain !== expected.receivingDomain) {
    return err({
      code: "MISMATCH",
      status: 422,
      message: "routeOption receivingDomain does not match selected corridor",
    });
  }

  if (option.label === "locked") {
    if (!option.quote) {
      return err({
        code: "INVALID_LOCKED_QUOTE",
        status: 422,
        message: "locked routeOption must carry a quote",
      });
    }
    if (option.quote.expiresAt <= expected.nowMs) {
      return err({
        code: "EXPIRED",
        status: 409,
        message: "locked quote on chosen route option has expired",
      });
    }
    if (
      option.quote.sourceAmount.asset !== expected.sourceAmount.asset ||
      option.quote.sourceAmount.amount !== expected.sourceAmount.amount
    ) {
      return err({
        code: "MISMATCH",
        status: 422,
        message: "locked quote sourceAmount does not match request sourceAmount",
      });
    }
  }

  return ok(payload);
}
