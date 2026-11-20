import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type Quote } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
} from "@corridor/engine";
import {
  createService,
  signRouteOption,
  type ChosenRouteOptionPayload,
  type ServiceOptions,
} from "@corridor/service";

const ROUTE_OPTION_SECRET = "test-route-option-hmac-secret-0123456789abcdef";

function buildCorridor(): Corridor {
  const parsed = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!parsed.ok) {
    throw new Error("corridor fixture invalid");
  }
  return parsed.value;
}

function makeIntentBody(key = "pay-1") {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "sender-1" },
    recipient: { id: "recipient-1" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function makeHarness(
  opts: {
    nowMs?: number;
    routeOptionSecret?: string;
  } = {},
) {
  let quoteCalls = 0;
  let submitCalls = 0;
  let openQuoteId: string | undefined;

  const baseAdapter = createMockAdapter();
  const spyAdapter = {
    ...baseAdapter,
    async requestQuote(...args: Parameters<typeof baseAdapter.requestQuote>) {
      quoteCalls += 1;
      return baseAdapter.requestQuote(...args);
    },
    async openTransaction(
      intent: Parameters<typeof baseAdapter.openTransaction>[0],
      quote: Quote,
      corridor: Corridor,
    ) {
      openQuoteId = quote.id;
      return baseAdapter.openTransaction(intent, quote, corridor);
    },
  };

  const baseSubmitter = createMockSubmitter();
  const spySubmitter: EngineDeps["submitter"] = {
    ...baseSubmitter,
    async submit(req) {
      submitCalls += 1;
      return baseSubmitter.submit(req);
    },
  };

  const nowMs = opts.nowMs ?? 1_700_000_000_000;
  const serviceOpts: ServiceOptions = {
    corridors: new Map([["test", buildCorridor()]]),
    deps: {
      resolver: new StaticRouteResolver(() => spyAdapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: spySubmitter,
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      now: () => nowMs,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    },
    now: () => nowMs,
    ...(opts.routeOptionSecret !== undefined
      ? { routeOptionSecret: opts.routeOptionSecret }
      : {}),
  };

  return {
    service: createService(serviceOpts),
    getQuoteCalls: () => quoteCalls,
    getSubmitCalls: () => submitCalls,
    getOpenQuoteId: () => openQuoteId,
  };
}

describe("POST /payments routeOption", () => {
  const nowMs = 1_700_000_000_000;

  it("pins the signed locked quote on execution without re-quoting the adapter", async () => {
    const harness = makeHarness({ nowMs, routeOptionSecret: ROUTE_OPTION_SECRET });
    const payload: ChosenRouteOptionPayload = {
      corridorId: "test",
      receivingDomain: "d.example",
      protocol: "sep31",
      label: "locked",
      sourceAmount: { asset: "USDC", amount: "100.00" },
      expiresAt: nowMs + 60_000,
      quote: {
        id: "pinned-quote-99",
        sourceAmount: { asset: "USDC", amount: "100.00" },
        destAmount: { asset: "iso4217:ARS", amount: "125000.00" },
        price: "1250.00",
        expiresAt: nowMs + 60_000,
      },
    };
    const routeOption = signRouteOption(payload, ROUTE_OPTION_SECRET);

    const res = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-locked-1"),
        routeOption,
      },
    });

    expect(res.status).toBe(200);
    expect(harness.getQuoteCalls()).toBe(0);
    expect(harness.getSubmitCalls()).toBe(1);
    expect(harness.getOpenQuoteId()).toBe("pinned-quote-99");
  });

  it("accepts a signed indicative route option and proceeds cleanly", async () => {
    const harness = makeHarness({ nowMs, routeOptionSecret: ROUTE_OPTION_SECRET });
    const routeOption = signRouteOption(
      {
        corridorId: "test",
        receivingDomain: "d.example",
        protocol: "sep31",
        label: "indicative",
        sourceAmount: { asset: "USDC", amount: "100.00" },
        expiresAt: nowMs + 60_000,
      },
      ROUTE_OPTION_SECRET,
    );

    const res = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-indicative-1"),
        routeOption,
      },
    });

    expect(res.status).toBe(200);
    expect(harness.getQuoteCalls()).toBe(1);
    expect(harness.getSubmitCalls()).toBe(1);
  });

  it("rejects tampered signatures and modified quote payloads with 400 and zero money moved", async () => {
    const harness = makeHarness({ nowMs, routeOptionSecret: ROUTE_OPTION_SECRET });
    const signed = signRouteOption(
      {
        corridorId: "test",
        receivingDomain: "d.example",
        protocol: "sep31",
        label: "locked",
        sourceAmount: { asset: "USDC", amount: "100.00" },
        expiresAt: nowMs + 60_000,
        quote: {
          id: "pinned-quote-1",
          sourceAmount: { asset: "USDC", amount: "100.00" },
          destAmount: { asset: "iso4217:ARS", amount: "125000.00" },
          price: "1250.00",
          expiresAt: nowMs + 60_000,
        },
      },
      ROUTE_OPTION_SECRET,
    );

    const tamperedDestRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-tamper-1"),
        routeOption: {
          ...signed,
          quote: {
            ...signed.quote!,
            destAmount: { asset: "iso4217:ARS", amount: "9999999.00" },
          },
        },
      },
    });
    expect(tamperedDestRes.status).toBe(400);
    expect(tamperedDestRes.body).toMatchObject({
      error: "ROUTE_OPTION_INVALID",
      reason: "INVALID_SIGNATURE",
    });

    const badSigRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-tamper-2"),
        routeOption: {
          ...signed,
          signature: "0".repeat(64),
        },
      },
    });
    expect(badSigRes.status).toBe(400);
    expect(harness.getSubmitCalls()).toBe(0);
  });

  it("rejects expired options, mismatched fields, unconfigured pinning, and malformed payloads", async () => {
    const harness = makeHarness({ nowMs, routeOptionSecret: ROUTE_OPTION_SECRET });

    const expiredOption = signRouteOption(
      {
        corridorId: "test",
        receivingDomain: "d.example",
        protocol: "sep31",
        label: "indicative",
        sourceAmount: { asset: "USDC", amount: "100.00" },
        expiresAt: nowMs - 1,
      },
      ROUTE_OPTION_SECRET,
    );
    const expiredRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-expired"),
        routeOption: expiredOption,
      },
    });
    expect(expiredRes.status).toBe(409);

    const wrongAmountOption = signRouteOption(
      {
        corridorId: "test",
        receivingDomain: "d.example",
        protocol: "sep31",
        label: "indicative",
        sourceAmount: { asset: "USDC", amount: "200.00" },
        expiresAt: nowMs + 60_000,
      },
      ROUTE_OPTION_SECRET,
    );
    const wrongAmountRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-mismatch"),
        routeOption: wrongAmountOption,
      },
    });
    expect(wrongAmountRes.status).toBe(422);

    const wrongDomainOption = signRouteOption(
      {
        corridorId: "test",
        receivingDomain: "evil.example",
        protocol: "sep31",
        label: "indicative",
        sourceAmount: { asset: "USDC", amount: "100.00" },
        expiresAt: nowMs + 60_000,
      },
      ROUTE_OPTION_SECRET,
    );
    const wrongDomainRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-wrong-domain"),
        routeOption: wrongDomainOption,
      },
    });
    expect(wrongDomainRes.status).toBe(422);

    const malformedRes = await harness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-malformed"),
        routeOption: { corridorId: "test", extraUnknown: true },
      },
    });
    expect(malformedRes.status).toBe(400);

    const unconfiguredHarness = makeHarness({ nowMs });
    const unconfiguredRes = await unconfiguredHarness.service.route({
      method: "POST",
      path: "/payments",
      headers: {},
      body: {
        ...makeIntentBody("pay-unconfigured"),
        routeOption: wrongAmountOption,
      },
    });
    expect(unconfiguredRes.status).toBe(422);
    expect(harness.getSubmitCalls()).toBe(0);
    expect(unconfiguredHarness.getSubmitCalls()).toBe(0);
  });
});
