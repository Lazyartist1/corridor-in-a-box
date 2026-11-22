// Lane readiness progression: 'closed' -> 'probably open' -> 'confirmed' (#635).
//
// Some receiving anchors allowlist sending partners only at `POST /transactions`,
// so a passing SEP probe cannot prove a live transaction will clear compliance.
// Until the first payment completes through a lane, an open lane is marked
// `'probably open'`; after the first completed payment, it transitions to `'confirmed'`.

export type LaneLifecycleState = "confirmed" | "probably open" | "closed";

export interface LaneConfirmationRecord {
  readonly domain: string;
  readonly completedPayments: number;
  readonly confirmedAt: number;
  readonly lastCompletedAt: number;
  readonly firstTransactionId?: string;
}

export interface LaneStateStore {
  get(domain: string): Promise<LaneConfirmationRecord | undefined>;
  recordCompletedPayment(
    domain: string,
    completedAt: number,
    transactionId?: string,
  ): Promise<LaneConfirmationRecord>;
}

export class InMemoryLaneStateStore implements LaneStateStore {
  private readonly records = new Map<string, LaneConfirmationRecord>();

  async get(domain: string): Promise<LaneConfirmationRecord | undefined> {
    return this.records.get(domain.trim().toLowerCase());
  }

  async recordCompletedPayment(
    domain: string,
    completedAt: number,
    transactionId?: string,
  ): Promise<LaneConfirmationRecord> {
    const key = domain.trim().toLowerCase();
    const existing = this.records.get(key);
    const updated: LaneConfirmationRecord = existing
      ? {
          domain: key,
          completedPayments: existing.completedPayments + 1,
          confirmedAt: existing.confirmedAt,
          lastCompletedAt: completedAt,
          firstTransactionId: existing.firstTransactionId ?? transactionId,
        }
      : {
          domain: key,
          completedPayments: 1,
          confirmedAt: completedAt,
          lastCompletedAt: completedAt,
          firstTransactionId: transactionId,
        };
    this.records.set(key, updated);
    return updated;
  }
}

export interface EvaluateLaneLifecycleInput {
  readonly domain: string;
  readonly probeRunnable: boolean;
  readonly manualOverride?: "open" | "closed";
  readonly store?: LaneStateStore;
}

export interface EvaluatedLaneLifecycle {
  readonly domain: string;
  readonly state: LaneLifecycleState;
  readonly source: "payment" | "probe" | "manual";
  readonly completedPayments: number;
  readonly confirmedAt?: number;
  readonly reason: string;
}

/**
 * Compute whether a lane is `'closed'`, `'probably open'` (open before first
 * completed settlement), or `'confirmed'` (at least one completed payment).
 */
export async function evaluateLaneLifecycle(
  input: EvaluateLaneLifecycleInput,
): Promise<EvaluatedLaneLifecycle> {
  const domain = input.domain.trim().toLowerCase();
  const confirmation = input.store ? await input.store.get(domain) : undefined;
  const completedPayments = confirmation?.completedPayments ?? 0;

  if (input.manualOverride === "closed") {
    return {
      domain,
      state: "closed",
      source: "manual",
      completedPayments,
      confirmedAt: confirmation?.confirmedAt,
      reason: "lane closed by manual override",
    };
  }

  const isOpen = input.manualOverride === "open" || input.probeRunnable;
  if (!isOpen) {
    return {
      domain,
      state: "closed",
      source: "probe",
      completedPayments,
      confirmedAt: confirmation?.confirmedAt,
      reason: "probe failed",
    };
  }

  if (confirmation && confirmation.completedPayments > 0) {
    return {
      domain,
      state: "confirmed",
      source: "payment",
      completedPayments: confirmation.completedPayments,
      confirmedAt: confirmation.confirmedAt,
      reason: `confirmed after ${confirmation.completedPayments} completed payment(s)`,
    };
  }

  return {
    domain,
    state: "probably open",
    source: input.manualOverride === "open" ? "manual" : "probe",
    completedPayments: 0,
    reason:
      input.manualOverride === "open"
        ? "probably open (manual override, no completed payment yet)"
        : "probably open (probe passed, no completed payment yet)",
  };
}
