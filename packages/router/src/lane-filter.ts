// Planner step filtering candidates by lane readiness state (#636).
//
// Drops closed lanes with a plain reason and labels `'probably open'` lanes so
// callers know whether a route is already confirmed by completed traffic.

export type CandidateLaneState = "confirmed" | "probably open" | "closed";

export interface LaneStateDecision {
  readonly state: CandidateLaneState;
  readonly reason?: string;
}

export type LaneStateLookup = (
  domain: string,
) => Promise<LaneStateDecision> | LaneStateDecision;

export interface LaneFilterCandidate {
  readonly domain: string;
  readonly receivingDomain?: string;
  readonly protocol?: string;
  readonly reason?: string;
}

export type EligibleLaneCandidate<T extends LaneFilterCandidate> = T & {
  readonly receivingDomain: string;
  readonly laneState: "confirmed" | "probably open";
  readonly laneLabel?: "probably open";
  readonly reason: string;
};

export interface DroppedLaneCandidate {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol?: string;
  readonly dropped: true;
  readonly laneState: "closed";
  readonly reason: string;
}

export interface LaneFilterResult<T extends LaneFilterCandidate> {
  readonly kept: readonly EligibleLaneCandidate<T>[];
  readonly dropped: readonly DroppedLaneCandidate[];
}

/**
 * Partition candidate routes by lane state:
 * - `"closed"` candidates are dropped with their closure reason.
 * - `"probably open"` candidates are kept and explicitly labelled `'probably open'`.
 * - `"confirmed"` candidates pass cleanly without a tentative warning label.
 */
export async function filterCandidatesByLaneState<T extends LaneFilterCandidate>(
  candidates: readonly T[],
  lookup: LaneStateLookup,
): Promise<LaneFilterResult<T>> {
  const evaluations = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      status: await lookup(candidate.domain),
    })),
  );

  const kept: EligibleLaneCandidate<T>[] = [];
  const dropped: DroppedLaneCandidate[] = [];

  for (const { candidate, status } of evaluations) {
    const receivingDomain = candidate.receivingDomain ?? candidate.domain;
    if (status.state === "closed") {
      dropped.push({
        domain: candidate.domain,
        receivingDomain,
        protocol: candidate.protocol,
        dropped: true,
        laneState: "closed",
        reason: status.reason
          ? `dropped: lane closed (${status.reason})`
          : "dropped: lane closed",
      });
      continue;
    }

    if (status.state === "probably open") {
      kept.push({
        ...candidate,
        receivingDomain,
        laneState: "probably open",
        laneLabel: "probably open",
        reason: candidate.reason
          ? `${candidate.reason}; probably open`
          : (status.reason ?? "probably open"),
      });
      continue;
    }

    kept.push({
      ...candidate,
      receivingDomain,
      laneState: "confirmed",
      reason: candidate.reason ?? status.reason ?? "confirmed lane",
    });
  }

  return { kept, dropped };
}
