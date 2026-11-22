// Pure copy decisions for the anchor card, so they can be tested without a DOM.
//
// The card must keep two facts apart: what an anchor's stellar.toml ADVERTISES,
// and what the probe actually MANAGED to read. An empty `seps` means different
// things in those two cases. When toml_fetch did not pass the probe never read
// the toml, so "no SEP endpoints" would be a claim about the anchor that the
// attestation simply does not support.

import { type AnchorAttestation, STALE_AFTER_LEDGERS } from "./registry";

const ZERO_HASH = "0".repeat(64);

export type AnchorBadge = "serves-sep31" | "stale" | "unreachable" | "no-sep31";

export interface AnchorCardCopy {
  sepsLabel: string;
  badge: AnchorBadge;
  /** Null when the toml was never fetched: an all-zero hash is not a hash. */
  tomlHash: string | null;
}

/** True when the probe ran toml_fetch but it did not pass. */
export function tomlUnreachable(anchor: AnchorAttestation): boolean {
  return anchor.probesRun.includes("toml_fetch") && !anchor.probesPassed.includes("toml_fetch");
}

export function anchorCardCopy(anchor: AnchorAttestation, staleOverride?: boolean): AnchorCardCopy {
  const stale = staleOverride ?? anchor.staleness > STALE_AFTER_LEDGERS;
  const unreachable = tomlUnreachable(anchor);
  const tomlHash = anchor.tomlHash === ZERO_HASH ? null : anchor.tomlHash;

  let sepsLabel: string;
  let badge: AnchorBadge;
  if (unreachable) {
    sepsLabel = "stellar.toml unreachable from the probe";
    badge = "unreachable";
  } else {
    sepsLabel = anchor.seps.length
      ? anchor.seps.map((n) => `SEP-${n}`).join(" · ")
      : "no SEP endpoints";
    if (anchor.servesSep31 && !stale) {
      badge = "serves-sep31";
    } else if (anchor.servesSep31) {
      badge = "stale";
    } else {
      badge = "no-sep31";
    }
  }

  return { sepsLabel, badge, tomlHash };
}
