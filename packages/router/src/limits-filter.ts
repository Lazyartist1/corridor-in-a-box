// Router limits and required-fields filter (#606).
//
// Reads SEP-31 /info limits (`min_amount`, `max_amount`) and required
// transaction fields (with optional caching) so routes that would fail on
// limits or missing inputs are dropped before requesting a firm quote.

import { compareAmounts, type Money, type Outcome } from "@corridor/types";

export interface TransactionFieldSpec {
  readonly description?: string;
  readonly optional?: boolean;
  readonly choices?: readonly string[];
}

export interface RouteAssetCapabilities {
  readonly enabled?: boolean;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly transactionFields?: Readonly<Record<string, TransactionFieldSpec>>;
}

export interface LimitsFilterCandidate {
  readonly domain: string;
  readonly receivingDomain?: string;
  readonly protocol?: string;
  readonly asset: string;
  readonly capabilities?: RouteAssetCapabilities;
  readonly fetchInfo?: () => Promise<Outcome<RouteAssetCapabilities | undefined>>;
}

export interface LimitsDroppedCandidate {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol?: string;
  readonly dropped: true;
  readonly reason: string;
}

export type LimitsEligibleCandidate<T extends LimitsFilterCandidate> = T & {
  readonly receivingDomain: string;
  readonly capabilities: RouteAssetCapabilities;
};

export interface LimitsFilterResult<T extends LimitsFilterCandidate> {
  readonly offered: readonly LimitsEligibleCandidate<T>[];
  readonly dropped: readonly LimitsDroppedCandidate[];
}

export interface Sep31InfoCacheOptions {
  /** Cache lifetime in milliseconds (default 5 minutes). */
  readonly ttlMs?: number;
  /** Injectable clock for deterministic cache expiry tests. */
  readonly now?: () => number;
}

/** Caches `/info` capability lookups per `(domain, asset)` within a TTL. */
export class CachedCapabilitiesStore {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: Outcome<RouteAssetCapabilities | undefined> }
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: Sep31InfoCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolve(
    domain: string,
    asset: string,
    loader: () => Promise<Outcome<RouteAssetCapabilities | undefined>>,
  ): Promise<Outcome<RouteAssetCapabilities | undefined>> {
    const key = `${domain.toLowerCase()}::${asset}`;
    const existing = this.cache.get(key);
    const current = this.now();
    if (existing && current < existing.expiresAt) {
      return existing.value;
    }
    const loaded = await loader();
    this.cache.set(key, { expiresAt: current + this.ttlMs, value: loaded });
    return loaded;
  }
}

export interface LimitsFilterInput {
  readonly sourceAmount: Money;
  readonly suppliedFields?: Readonly<Record<string, string>>;
}

export interface LimitsFilterOptions {
  readonly cache?: CachedCapabilitiesStore;
}

function drop(candidate: LimitsFilterCandidate, reason: string): LimitsDroppedCandidate {
  return {
    domain: candidate.domain,
    receivingDomain: candidate.receivingDomain ?? candidate.domain,
    protocol: candidate.protocol,
    dropped: true,
    reason,
  };
}

function findMissingRequiredFields(
  fields: Readonly<Record<string, TransactionFieldSpec>> | undefined,
  supplied: Readonly<Record<string, string>> = {},
): string[] {
  if (!fields) return [];
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.optional) continue;
    const val = supplied[name];
    if (typeof val !== "string" || val.trim().length === 0) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Filter candidate anchors against SEP-31 `/info` limits (`min_amount`,
 * `max_amount`) and required transaction fields.
 */
export async function filterByLimitsAndFields<T extends LimitsFilterCandidate>(
  candidates: readonly T[],
  input: LimitsFilterInput,
  opts: LimitsFilterOptions = {},
): Promise<LimitsFilterResult<T>> {
  const offered: LimitsEligibleCandidate<T>[] = [];
  const dropped: LimitsDroppedCandidate[] = [];

  for (const candidate of candidates) {
    let caps = candidate.capabilities;
    if (!caps && candidate.fetchInfo) {
      const outcome = opts.cache
        ? await opts.cache.resolve(candidate.domain, candidate.asset, candidate.fetchInfo)
        : await candidate.fetchInfo();
      if (!outcome.ok) {
        dropped.push(drop(candidate, `info lookup failed: ${outcome.error.message}`));
        continue;
      }
      caps = outcome.value;
    }

    if (!caps) {
      dropped.push(
        drop(candidate, `asset ${input.sourceAmount.asset} not advertised by anchor`),
      );
      continue;
    }
    if (caps.enabled === false) {
      dropped.push(
        drop(candidate, `asset ${candidate.asset} is disabled at ${candidate.domain}`),
      );
      continue;
    }

    if (caps.minAmount !== undefined) {
      const cmpMin = compareAmounts(input.sourceAmount.amount, caps.minAmount);
      if (!cmpMin.ok) {
        dropped.push(
          drop(candidate, `invalid amount for limit check: ${cmpMin.error.message}`),
        );
        continue;
      }
      if (cmpMin.value < 0) {
        dropped.push(
          drop(
            candidate,
            `amount ${input.sourceAmount.amount} ${input.sourceAmount.asset} below min ${caps.minAmount}`,
          ),
        );
        continue;
      }
    }

    if (caps.maxAmount !== undefined) {
      const cmpMax = compareAmounts(input.sourceAmount.amount, caps.maxAmount);
      if (!cmpMax.ok) {
        dropped.push(
          drop(candidate, `invalid amount for limit check: ${cmpMax.error.message}`),
        );
        continue;
      }
      if (cmpMax.value > 0) {
        dropped.push(
          drop(
            candidate,
            `amount ${input.sourceAmount.amount} ${input.sourceAmount.asset} above max ${caps.maxAmount}`,
          ),
        );
        continue;
      }
    }

    const missing = findMissingRequiredFields(caps.transactionFields, input.suppliedFields);
    if (missing.length > 0) {
      dropped.push(drop(candidate, `missing required field: ${missing.join(", ")}`));
      continue;
    }

    offered.push({
      ...candidate,
      receivingDomain: candidate.receivingDomain ?? candidate.domain,
      capabilities: caps,
    });
  }

  return { offered, dropped };
}
