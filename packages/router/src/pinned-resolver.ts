// PinnedRouteResolver — resolve exclusively to the anchor pinned on the stored run (#625).
//
// Once a run has recorded its receiving anchor domain (and optionally protocol),
// re-resolving on resume must return that exact anchor rather than choosing a new
// one. If no route is stored, refuse rather than guessing. On the public
// network (or whenever a registry is configured), attestation is still verified.

import { protocolOf, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";
import type { RouteDecision, RouteResolver } from "./index";
import {
  UnattestedAnchorError,
  asAttestationSource,
  checkAttestation,
  isUnattestedDomainAllowed,
  type AttestationSource,
  type AttestationSourceLike,
} from "./registry-resolver";

/** Minimal stored-run projection `PinnedRouteResolver` reads by `idempotencyKey`. */
export interface PinnedRunRecord {
  readonly corridorId?: string;
  readonly receivingDomain?: string;
  readonly routeProtocol?: string;
}

/** Structural store interface avoiding a runtime dependency on `@corridor/engine`. */
export interface PinnedRunStore {
  get(idempotencyKey: string): Promise<PinnedRunRecord | undefined>;
}

/** Thrown when no pinned route is stored for the run or its corridor conflicts. */
export class UnpinnedRouteError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly reason: string,
  ) {
    super(`refusing to resolve unpinned route for ${idempotencyKey}: ${reason}`);
    this.name = "UnpinnedRouteError";
  }
}

export interface PinnedRouteResolverOptions {
  /** Store holding persisted runs keyed by `idempotencyKey`. */
  readonly runs: PinnedRunStore;
  /** Adapter factory invoked with the pinned corridor. */
  readonly adapterFor: (corridor: Corridor) => AnchorAdapter;
  /** Registry attestation source required on `public` corridors unless exempt. */
  readonly registry?: AttestationSourceLike;
  /** Maximum attestation age in ledgers (same default as `RegistryRouteResolver`). */
  readonly maxStalenessLedgers?: number;
  /** Explicit allowlist of domains exempt from attestation checks (same semantics as RegistryRouteResolver). */
  readonly allowUnattestedDomains?: readonly string[];
  /**
   * Optional lookup returning the canonical `Corridor` for a pinned
   * `(domain, protocol)`. When omitted, the passed corridor is used only if it
   * already points at the pinned domain (its protocol may be re-pinned). A
   * pinned domain that differs is refused: rewriting `home_domain` alone would
   * attest one anchor while the adapter still calls the other's endpoints.
   */
  readonly corridorFor?: (
    domain: string,
    protocol: string,
    corridor: Corridor,
  ) => Corridor | undefined;
}

/**
 * Pin the passed corridor to `protocol` when it already belongs to `domain`.
 * Returns undefined when the corridor points at a different anchor: its
 * endpoints are that anchor's, so only a `corridorFor` lookup can supply the
 * pinned anchor's corridor.
 */
function pinCorridor(
  corridor: Corridor,
  domain: string,
  protocol: string,
): Corridor | undefined {
  if (corridor.dest.endpoints.home_domain !== domain) return undefined;
  if (protocolOf(corridor.dest) === protocol) return corridor;
  return {
    ...corridor,
    dest: {
      ...corridor.dest,
      protocol: protocol as Corridor["dest"]["protocol"],
    } as Corridor["dest"],
  };
}

export class PinnedRouteResolver implements RouteResolver {
  private readonly runs: PinnedRunStore;
  private readonly adapterFor: (corridor: Corridor) => AnchorAdapter;
  private readonly registry?: AttestationSource;
  private readonly maxStaleness?: number;
  private readonly allowed: readonly string[];
  private readonly corridorFor?: PinnedRouteResolverOptions["corridorFor"];

  constructor(opts: PinnedRouteResolverOptions) {
    this.runs = opts.runs;
    this.adapterFor = opts.adapterFor;
    this.registry = opts.registry ? asAttestationSource(opts.registry) : undefined;
    this.maxStaleness = opts.maxStalenessLedgers;
    this.allowed = opts.allowUnattestedDomains ?? [];
    this.corridorFor = opts.corridorFor;
  }

  async resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const stored = await this.runs.get(intent.idempotencyKey);
    if (!stored || !stored.receivingDomain) {
      throw new UnpinnedRouteError(
        intent.idempotencyKey,
        "no receivingDomain stored for this run",
      );
    }
    if (stored.corridorId !== undefined && stored.corridorId !== corridor.id) {
      throw new UnpinnedRouteError(
        intent.idempotencyKey,
        `stored route belongs to corridor "${stored.corridorId}", not "${corridor.id}"`,
      );
    }

    const domain = stored.receivingDomain;
    const protocol = stored.routeProtocol ?? protocolOf(corridor.dest);
    const pinnedCorridor = this.corridorFor
      ? this.corridorFor(domain, protocol, corridor)
      : pinCorridor(corridor, domain, protocol);

    if (!pinnedCorridor) {
      throw new UnpinnedRouteError(
        intent.idempotencyKey,
        this.corridorFor
          ? `no corridor definition found for pinned route ${domain} (${protocol})`
          : `pinned route ${domain} differs from corridor anchor ` +
              `${corridor.dest.endpoints.home_domain} and no corridorFor lookup is configured; ` +
              `refusing to reuse that anchor's endpoints`,
      );
    }

    const exempt = isUnattestedDomainAllowed(domain, this.allowed);
    if (exempt) {
      return { receiving: this.adapterFor(pinnedCorridor), trust: "attested" };
    }

    if (corridor.settlement.network === "public" || this.registry !== undefined) {
      if (!this.registry) {
        throw new UnattestedAnchorError(
          domain,
          "public network corridor requires registry attestation",
          protocol,
        );
      }
      // Same gate as RegistryRouteResolver: fails closed on a stale, missing or unreadable attestation.
      const check = await checkAttestation(this.registry, domain, protocol, this.maxStaleness);
      if (!check.ok) throw new UnattestedAnchorError(domain, check.detail, protocol);
      return { receiving: this.adapterFor(pinnedCorridor), trust: "attested" };
    }

    return { receiving: this.adapterFor(pinnedCorridor), trust: "manifest" };
  }
}
