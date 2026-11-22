// Manual lane open/closed configuration override (#634).
//
// An operator can configure a domain/lane override when they hold a bilateral
// contract before a probe confirms it (or need to close an active lane). The
// override always wins over the probe result and records `source: "manual"`.

export type ManualOverrideState = "open" | "closed";

export interface LaneOverrideEntry {
  /** Forced lane state overriding any probe result. */
  readonly state: ManualOverrideState;
  /** Human-readable explanation recorded when the override was set. */
  readonly reason?: string;
  /** Optional epoch milliseconds timestamp when the override was recorded. */
  readonly updatedAt?: number;
  /** Optional operator identifier that applied the override. */
  readonly updatedBy?: string;
}

export type LaneOverrideConfig = Readonly<
  Record<string, LaneOverrideEntry | ManualOverrideState>
>;

export interface ProbeStatusInput {
  /** Receiving anchor canonical home domain or lane id. */
  readonly domain: string;
  /** Underlying probe result when known. */
  readonly runnable: boolean;
  /** Epoch milliseconds when the probe ran. */
  readonly checkedAt?: number;
  /** Optional explanation produced by the probe. */
  readonly reason?: string;
}

export interface LaneCheckResolution {
  readonly domain: string;
  readonly state: "open" | "closed";
  /** Origin of `state`: `"manual"` when overridden by config, else `"probe"`. */
  readonly source: "manual" | "probe";
  readonly manual: boolean;
  readonly reason: string;
  readonly probeRunnable: boolean;
  readonly checkedAt?: number;
  readonly updatedAt?: number;
  readonly updatedBy?: string;
}

function normalizeOverride(
  entry: LaneOverrideEntry | ManualOverrideState | undefined,
): LaneOverrideEntry | undefined {
  if (entry === undefined) return undefined;
  return typeof entry === "string" ? { state: entry } : entry;
}

function lookupOverride(
  domain: string,
  overrides: LaneOverrideConfig | undefined,
): LaneOverrideEntry | undefined {
  if (!overrides) return undefined;
  const direct = overrides[domain];
  if (direct !== undefined) return normalizeOverride(direct);
  const lower = domain.trim().toLowerCase();
  for (const [k, v] of Object.entries(overrides)) {
    if (k.trim().toLowerCase() === lower) {
      return normalizeOverride(v);
    }
  }
  return undefined;
}

/**
 * Resolve lane availability by applying any configured manual open/closed override
 * on top of the probe result. Overrides always win and record `source: "manual"`.
 */
export function resolveManualLaneOverride(
  input: ProbeStatusInput,
  overrides?: LaneOverrideConfig,
): LaneCheckResolution {
  const domain = input.domain.trim().toLowerCase();
  const override = lookupOverride(domain, overrides);

  if (override !== undefined) {
    return {
      domain,
      state: override.state,
      source: "manual",
      manual: true,
      reason: override.reason ?? `manual ${override.state} override`,
      probeRunnable: input.runnable,
      checkedAt: input.checkedAt,
      updatedAt: override.updatedAt,
      updatedBy: override.updatedBy,
    };
  }

  return {
    domain,
    state: input.runnable ? "open" : "closed",
    source: "probe",
    manual: false,
    reason: input.reason ?? (input.runnable ? "probe passed" : "probe failed"),
    probeRunnable: input.runnable,
    checkedAt: input.checkedAt,
  };
}

/** Render a plain human-readable summary clearly marking manual overrides as `[manual]`. */
export function formatLaneResolution(resolution: LaneCheckResolution): string {
  const tag = resolution.source === "manual" ? "[manual]" : "[probe]";
  return `${resolution.domain}: ${resolution.state} ${tag} — ${resolution.reason}`;
}
