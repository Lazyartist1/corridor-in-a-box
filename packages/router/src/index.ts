// @corridor/router — the RouteResolver seam drawn in code.
//
// The interface and two open resolvers ship here: StaticRouteResolver (trust the
// manifest) and RegistryRouteResolver (require a fresh on-chain attestation). A
// resolver weighted by anchor health, conformance, latency, and proprietary
// routing data could be supplied separately in the future; no such proprietary
// component is included or injected here.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter, SourceAnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";
import type { AllowedPriceLabel } from "./label-policy";

/**
 * One option a resolver considered for a payment, with why it ranked where it
 * did. Reasons are short, PII-free strings (e.g. "attested 2h ago",
 * "p95 settle 41s"): they are written to the append-only audit trail.
 *
 * Deliberately not RFC 0004's planned `RouteOption`: this is only the part of
 * an option the audit trail keeps about a choice.
 */
export interface RankedOption {
  /** Stable id for the option, e.g. the receiving anchor's adapter name or domain. */
  readonly id: string;
  /**
   * The RFC 0004 price label of the option's price: `locked` (a firm SEP-38
   * quote), `indicative` (the anchor's current price, not promised) or
   * `estimated` (from rate history). Omit it for an option that could not be
   * priced. See docs/rfcs/0004-smart-router.md#2-price-labels-shown-to-people.
   */
  readonly label?: AllowedPriceLabel;
  /** 1-based rank; 1 is the best option. */
  readonly rank: number;
  /** Why the option ranked where it did, most important first. */
  readonly reasons: readonly string[];
}

/** How a resolver ranked its options, so the choice can be explained later. */
export interface OptionRanking {
  /** `id` of the option the resolver chose; it should match `receiving`. */
  readonly chosen: string;
  /** Every option considered, in any order; the engine audits the top three by rank. */
  readonly options: readonly RankedOption[];
}

export interface RouteDecision {
  /** The receiving anchor chosen for this payment. */
  readonly receiving: AnchorAdapter;
  /** Sending anchor used to on-ramp funds for non-prefunded corridors. */
  readonly sending?: SourceAnchorAdapter;
  /**
   * Reserved for split routing across multiple anchors (weights sum to 1).
   * The engine ignores this field today and reads only `receiving`, so setting
   * it does not change where a payment goes. See docs/route-resolver.md#split.
   */
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
  /** How the route decision was reached: verified against on-chain evidence or assumed from manifest. */
  readonly trust: "attested" | "manifest";
  /**
   * Optional ranking behind the choice. When present the engine records the
   * chosen option with its price label and rank, and the top three options
   * with their reasons, in the audit trail; when absent it records the receiving adapter as the only option.
   * See docs/route-resolver.md#recording-the-choice.
   */
  readonly ranking?: OptionRanking;
}

/**
 * Chooses the receiving anchor for a payment. This is the open/closed seam.
 *
 * The engine may call `resolve()` more than once for the same payment (on the
 * first run and again on resume), so the result should be stable for the same
 * inputs. `resolve()` may throw to fail closed: `RegistryRouteResolver` throws
 * `UnattestedAnchorError` rather than return a route it cannot vouch for. The
 * full contract is in docs/route-resolver.md#the-routeresolver-interface.
 */
export interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

export interface StaticRouteResolverOptions {
  readonly trustManifestWithoutAttestation?: boolean;
  readonly sourceAdapterFor?: (corridor: Corridor) => SourceAnchorAdapter;
}

/**
 * Default resolver: use the single anchor the manifest declares. No intelligence.
 * Swap this out for another RouteResolver implementation if one is developed;
 * the interface is an extension seam, not evidence of a separate closed repo.
 */
export class StaticRouteResolver implements RouteResolver {
  constructor(
    private readonly adapterFor: (corridor: Corridor) => AnchorAdapter,
    private readonly options?: StaticRouteResolverOptions,
  ) {
    if (!options?.trustManifestWithoutAttestation) {
      throw new Error(
        "StaticRouteResolver requires explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      );
    }
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const sending = this.options?.sourceAdapterFor?.(corridor);
    return {
      receiving: this.adapterFor(corridor),
      ...(sending ? { sending } : {}),
      trust: "manifest",
    };
  }
}

// The registry-backed resolver: the evidence-based resolver, in code.
// StaticRouteResolver above trusts the manifest; this one requires evidence.
export {
  RegistryRouteResolver,
  UnattestedAnchorError,
  asAttestationSource,
  checkAttestation,
  isAttestedProtocol,
  isUnattestedDomainAllowed,
  type AttestationCheck,
  type AttestationRefusal,
  type AttestationSource,
  type AttestationSourceLike,
  type AttestedProtocol,
  type LegacyAttestationSource,
  type RegistryResolverOptions,
} from "./registry-resolver";

// Planner step: keep only candidates the registry can vouch for, with reasons
// for the rest. Same rules as RegistryRouteResolver, via checkAttestation.
export {
  filterByEvidence,
  type EvidenceCandidate,
  type EvidenceFilterDeps,
  type EvidenceFilterResult,
} from "./evidence-filter";

// Deploy-time injection: load a RouteResolver module named in config (e.g.
// CORRIDOR_RESOLVER_MODULE) instead of editing code. The module below the
// seam stays private; the seam itself stays open.
export {
  loadResolver,
  ResolverLoadError,
  ROUTE_RESOLVER_API_VERSION,
  type LoadResolverSpec,
  type LoadResolverCtx,
} from "./load";

export { createAdapterRegistry } from "./adapters";
export type { AdapterFactory, AdapterRegistry } from "./adapters";

// SEP-10 lane check: whether a receiving anchor's login accepts our own key.
export {
  checkLane,
  type LaneCheckOptions,
  type LaneCheckResult,
  type LaneStatus,
} from "./lane-check";
export { appendOptionReason, formatOptionReason, summarizeOptionReasons } from "./reasons";
export type { OptionReasonStep, ReasonedOption, SummarizedOptionReason } from "./reasons";
export {
  DEFAULT_PARALLEL_DEADLINE_MS,
  formatNoPriceWithinReason,
  priceCandidatesInParallel,
} from "./parallel-pricer";
export type {
  DroppedCandidateResult,
  ParallelPricingCandidate,
  ParallelPricingOptions,
  ParallelPricingResult,
  PriceAnchorContext,
  PriceCandidateFn,
  PricedCandidateResult,
} from "./parallel-pricer";

export { requestLockedOption } from "./firm-quote";
export type {
  FirmQuoteCandidate,
  FirmQuoteDroppedOption,
  FirmQuoteResult,
  LockedRouteOption,
  RequestLockedOptionOptions,
} from "./firm-quote";
export { filterByCircuitBreaker } from "./breaker-filter";
export type {
  BreakerDroppedCandidate,
  BreakerFilterCandidate,
  BreakerFilterResult,
  BreakerStateReader,
  BreakerStatusRecord,
} from "./breaker-filter";
export { ALL_PRICE_LABELS, filterOptionsByAllowedLabels } from "./label-policy";
export type {
  AllowedPriceLabel,
  LabelledRouteOption,
  LabelPolicy,
  LabelPolicyFilterResult,
  LabelRejectedOption,
} from "./label-policy";

export { CachedCapabilitiesStore, filterByLimitsAndFields } from "./limits-filter";
export type {
  LimitsDroppedCandidate,
  LimitsEligibleCandidate,
  LimitsFilterCandidate,
  LimitsFilterInput,
  LimitsFilterOptions,
  LimitsFilterResult,
  RouteAssetCapabilities,
  Sep31InfoCacheOptions,
  TransactionFieldSpec,
} from "./limits-filter";

export type {
  PriceLabel,
  RouteOption,
  RoutePlanner,
  RoutePolicy,
  RouteRequest,
} from "./planner";

export {
  buildEstimatedOption,
  DEFAULT_MIN_ESTIMATE_SPAN_DAYS,
  DEFAULT_ESTIMATE_WINDOW_DAYS,
  DEFAULT_MIN_ESTIMATE_SAMPLES,
} from "./estimated-price";
export type {
  EstimatedPriceDetails,
  EstimatedPriceDropped,
  EstimatedPriceOffered,
  EstimatedPriceOutcome,
  EstimatedPricePolicy,
  EstimatePriceRequest,
  RateSample,
} from "./estimated-price";
export {
  DEFAULT_ESTIMATE_MARGIN_BPS,
  applyEstimateMargin,
  fetchIndicativePrice,
} from "./indicative-price";
export type { IndicativePriceRequest, IndicativeRouteOption } from "./indicative-price";
export { PinnedRouteResolver, UnpinnedRouteError } from "./pinned-resolver";
export type {
  PinnedRouteResolverOptions,
  PinnedRunRecord,
  PinnedRunStore,
} from "./pinned-resolver";
