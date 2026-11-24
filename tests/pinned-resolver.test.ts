import { describe, expect, it } from "vitest";
import { createMockAdapter, type AnchorAdapter } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import {
  PinnedRouteResolver,
  UnattestedAnchorError,
  UnpinnedRouteError,
  type AttestationSource,
  type PinnedRunRecord,
  type PinnedRunStore,
} from "@corridor/router";
import { describeResolverContract } from "@corridor/router/testing";
import { InMemoryIdempotencyStore, createMockSubmitter, execute } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(
  id = "c1",
  homeDomain = "pinned.example",
  network: "public" | "testnet" = "public",
): Corridor {
  const r = parseCorridor({
    id,
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      protocol: "sep31",
      endpoints: {
        home_domain: homeDomain,
        transfer_server_sep31: `https://${homeDomain}/sep31`,
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network, asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-1",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${r.error.message}`);
  return r.value;
}

function registryFor(attestedDomain: string, staleness = 0): AttestationSource {
  return {
    serves: async (domain, protocol) => domain === attestedDomain && protocol === "sep31",
    staleness: async () => staleness,
    tomlHash: async () => "0".repeat(64),
  };
}

function adapterForDomain(c: Corridor): AnchorAdapter {
  return createMockAdapter({ name: c.dest.endpoints.home_domain });
}

function mapStore(entries: Record<string, PinnedRunRecord>): PinnedRunStore {
  return {
    async get(key) {
      return entries[key];
    },
  };
}

const intent: PaymentIntent = {
  idempotencyKey: "run-1",
  corridorId: "c1",
  sender: { id: "s1" },
  recipient: { id: "r1" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

describe("PinnedRouteResolver (#625)", () => {
  it("refuses when no run or no receivingDomain is stored", async () => {
    const empty = new PinnedRouteResolver({
      runs: mapStore({}),
      adapterFor: adapterForDomain,
      registry: registryFor("pinned.example"),
    });
    await expect(empty.resolve(intent, corridor())).rejects.toThrow(UnpinnedRouteError);

    const noDomain = new PinnedRouteResolver({
      runs: mapStore({ "run-1": { corridorId: "c1" } }),
      adapterFor: adapterForDomain,
      registry: registryFor("pinned.example"),
    });
    await expect(noDomain.resolve(intent, corridor())).rejects.toThrow(UnpinnedRouteError);
  });

  it("refuses when the stored corridorId disagrees with the requested corridor", async () => {
    const resolver = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "other-corridor",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: adapterForDomain,
      registry: registryFor("pinned.example"),
    });
    await expect(resolver.resolve(intent, corridor("c1"))).rejects.toThrow(UnpinnedRouteError);
  });

  it("returns the exact stored anchor domain even across repeated/resumed calls", async () => {
    const seenDomains: string[] = [];
    const seenServers: string[] = [];
    const resolver = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: (c) => {
        seenDomains.push(c.dest.endpoints.home_domain);
        seenServers.push(
          String((c.dest.endpoints as Record<string, unknown>).transfer_server_sep31),
        );
        return adapterForDomain(c);
      },
      registry: registryFor("pinned.example"),
      corridorFor: (domain, _protocol, c) => corridor(c.id, domain),
    });

    const first = await resolver.resolve(intent, corridor("c1", "candidate-a.example"));
    const second = await resolver.resolve(intent, corridor("c1", "candidate-b.example"));
    expect(first.trust).toBe("attested");
    expect(first.receiving.name).toBe("pinned.example");
    expect(second.receiving.name).toBe("pinned.example");
    expect(seenDomains).toEqual(["pinned.example", "pinned.example"]);
    // The adapter gets the pinned anchor's own endpoints, not the candidate's.
    expect(seenServers).toEqual([
      "https://pinned.example/sep31",
      "https://pinned.example/sep31",
    ]);
  });

  it("refuses a pinned domain that differs from the corridor when corridorFor is missing", async () => {
    let adapterCalls = 0;
    let registryCalls = 0;
    const resolver = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: (c) => {
        adapterCalls += 1;
        return adapterForDomain(c);
      },
      registry: {
        ...registryFor("pinned.example"),
        serves: async () => {
          registryCalls += 1;
          return true;
        },
      },
    });

    const attempt = resolver.resolve(intent, corridor("c1", "candidate-a.example"));
    await expect(attempt).rejects.toThrow(UnpinnedRouteError);
    await expect(attempt).rejects.toThrow(/differs from corridor anchor candidate-a\.example/);
    // Neither attested nor adapted: domain X is never attested while the adapter uses Y's endpoints.
    expect(adapterCalls).toBe(0);
    expect(registryCalls).toBe(0);
  });

  it("keeps using the passed corridor when it already points at the pinned domain", async () => {
    const resolver = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: adapterForDomain,
      registry: registryFor("pinned.example"),
    });
    const decision = await resolver.resolve(intent, corridor("c1", "pinned.example"));
    expect(decision.trust).toBe("attested");
    expect(decision.receiving.name).toBe("pinned.example");
  });

  it("still requires attestation on the public network", async () => {
    const noRegistryPublic = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: adapterForDomain,
    });
    await expect(
      noRegistryPublic.resolve(intent, corridor("c1", "pinned.example", "public")),
    ).rejects.toThrow(UnattestedAnchorError);

    const unattested = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: adapterForDomain,
      registry: registryFor("someone-else.example"),
    });
    await expect(
      unattested.resolve(intent, corridor("c1", "pinned.example", "public")),
    ).rejects.toThrow(UnattestedAnchorError);

    const testnetNoRegistry = new PinnedRouteResolver({
      runs: mapStore({
        "run-1": {
          corridorId: "c1",
          receivingDomain: "pinned.example",
          routeProtocol: "sep31",
        },
      }),
      adapterFor: adapterForDomain,
    });
    const testnetDecision = await testnetNoRegistry.resolve(
      intent,
      corridor("c1", "pinned.example", "testnet"),
    );
    expect(testnetDecision.trust).toBe("manifest");
    expect(testnetDecision.receiving.name).toBe("pinned.example");
  });

  it("resumes an interrupted run against its stored pinned anchor", async () => {
    const store = new InMemoryIdempotencyStore();
    const resolvedDomains: string[] = [];
    const customRuns = new Map<string, PinnedRunRecord>([
      [
        "resume-pinned-1",
        { corridorId: "c1", receivingDomain: "pinned.example", routeProtocol: "sep31" },
      ],
    ]);

    await store.put({
      idempotencyKey: "resume-pinned-1",
      corridorId: "c1",
      state: "settled",
      version: 5,
      transactionId: "tx-pinned",
      stellarTxHash: "hash-pinned",
    });

    const resolver = new PinnedRouteResolver({
      runs: { get: async (k) => customRuns.get(k) },
      adapterFor: (c) => {
        resolvedDomains.push(c.dest.endpoints.home_domain);
        return createMockAdapter({ name: c.dest.endpoints.home_domain });
      },
      registry: registryFor("pinned.example"),
      corridorFor: (domain, _protocol, c) => corridor(c.id, domain, c.settlement.network),
    });

    const res = await execute(
      { ...intent, idempotencyKey: "resume-pinned-1" },
      corridor("c1", "different-default.example", "public"),
      {
        resolver,
        submitter: createMockSubmitter(),
        idempotency: store,
        unsafeSkipPreSettleGate: true,
      },
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.state).toBe("completed");
    expect(resolvedDomains).toEqual(["pinned.example"]);
  });
});

describeResolverContract(
  "PinnedRouteResolver",
  (fixtures) =>
    new PinnedRouteResolver({
      runs: mapStore({
        [fixtures.intent.idempotencyKey]: {
          corridorId: fixtures.corridor.id,
          receivingDomain: fixtures.corridor.dest.endpoints.home_domain,
          routeProtocol: fixtures.corridor.dest.protocol,
        },
      }),
      adapterFor: adapterForDomain,
      registry: registryFor(fixtures.corridor.dest.endpoints.home_domain),
    }),
  {
    unresolvable: { outcome: "rejects", errorPattern: /stored route belongs to corridor/ },
  },
);
