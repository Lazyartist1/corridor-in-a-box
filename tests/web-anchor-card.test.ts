import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorCardCopy } from "../web/lib/anchor-card-copy";
import type { AnchorAttestation } from "../web/lib/registry";

const G = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ZERO_HASH = "0".repeat(64);
const REAL_HASH = "ab".repeat(32);

const base: AnchorAttestation = {
  domain: "bitso.com",
  seps: [],
  probesRun: ["toml_fetch"],
  probesPassed: [],
  tomlHash: ZERO_HASH,
  attestedLedger: 123,
  attester: G,
  staleness: 10,
  servesSep31: false,
};

describe("AnchorCard copy: toml_fetch did not pass", () => {
  const copy = anchorCardCopy(base, false);

  it("does not claim the anchor has no SEP endpoints or no SEP-31", () => {
    expect(copy.sepsLabel).not.toContain("no SEP endpoints");
    expect(copy.sepsLabel).not.toContain("no SEP-31");
    expect(copy.badge).not.toBe("no-sep31");
  });

  it("says the probe could not read the stellar.toml", () => {
    expect(copy.sepsLabel).toBe("stellar.toml unreachable from the probe");
    expect(copy.badge).toBe("unreachable");
  });

  it("hides the all-zero hash instead of showing it as a real one", () => {
    expect(copy.tomlHash).toBeNull();
  });
});

describe("AnchorCard copy: toml fetched", () => {
  it("still says no SEP endpoints when the toml was read and advertises none", () => {
    const anchor: AnchorAttestation = {
      ...base,
      domain: "empty.example",
      probesPassed: ["toml_fetch"],
      tomlHash: REAL_HASH,
    };
    const copy = anchorCardCopy(anchor, false);

    expect(copy.sepsLabel).toBe("no SEP endpoints");
    expect(copy.badge).toBe("no-sep31");
    expect(copy.tomlHash).toBe(REAL_HASH);
  });

  it("shows advertised SEPs and a green badge when SEP-31 serves and is fresh", () => {
    const anchor: AnchorAttestation = {
      ...base,
      seps: [1, 31],
      probesPassed: ["toml_fetch", "sep31_info"],
      tomlHash: "cd".repeat(32),
      servesSep31: true,
    };
    const copy = anchorCardCopy(anchor, false);

    expect(copy.sepsLabel).toBe("SEP-1 · SEP-31");
    expect(copy.badge).toBe("serves-sep31");
    expect(copy.tomlHash).toBe("cd".repeat(32));
  });

  it("never surfaces an all-zero hash even when the probe claims success", () => {
    const anchor: AnchorAttestation = { ...base, probesPassed: ["toml_fetch"] };
    expect(anchorCardCopy(anchor, false).tomlHash).toBeNull();
  });
});

describe("AnchorCard renders the computed copy", () => {
  const source = readFileSync(resolve(process.cwd(), "web/components/AnchorCard.tsx"), "utf8");

  it("uses the shared copy helper for the SEP line, badge and hash", () => {
    expect(source).toContain("anchorCardCopy");
    expect(source).toContain("copy.sepsLabel");
    expect(source).toContain("copy.badge");
    expect(source).toContain("copy.tomlHash");
  });

  it("does not hard-code the old unconditional verdicts", () => {
    expect(source).not.toContain(
      'anchor.seps.length ? anchor.seps.map((n) => `SEP-${n}`).join(" · ") : "no SEP endpoints"',
    );
  });
});
