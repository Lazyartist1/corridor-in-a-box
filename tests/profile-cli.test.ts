import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatProfileValidation,
  loadAndValidateProfile,
  validateCompanyProfile,
} from "../packages/cli/src/profile";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// The example profile #637 ships next to the schema is the fixture, so the CLI and the
// schema cannot drift apart without this suite noticing.
const EXAMPLE_PATH = fileURLToPath(
  new URL("../schemas/examples/company-profile.v0.json", import.meta.url),
);
const VALID_PROFILE = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")) as Record<
  string,
  unknown
>;

describe("company profile validator & CLI (#638)", () => {
  it("validates a complete v0 company profile", () => {
    const res = validateCompanyProfile(VALID_PROFILE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(formatProfileValidation("profile.json", res)).toContain(
        "Acorn Cross-Border Payments Ltd.",
      );
    }
  });

  it("reports missing required fields clearly", () => {
    const missing = structuredClone(VALID_PROFILE) as Record<string, unknown>;
    delete missing.amlCft;
    const res = validateCompanyProfile(missing);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "amlCft" && i.kind === "missing")).toBe(true);
      expect(formatProfileValidation("bad.json", res)).toContain("amlCft [missing]");
    }
  });

  it("reports wrong types on profile fields", () => {
    const wrongType = structuredClone(VALID_PROFILE) as {
      ownership: { beneficialOwners: Array<Record<string, unknown>> };
    };
    wrongType.ownership.beneficialOwners[0]!.ownershipPercent = "100";
    const res = validateCompanyProfile(wrongType);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (i) =>
            i.path === "ownership.beneficialOwners.0.ownershipPercent" &&
            i.kind === "invalid_type",
        ),
      ).toBe(true);
    }
  });

  it("rejects properties the v0 schema does not define", () => {
    const extra = structuredClone(VALID_PROFILE) as { legalEntity: Record<string, unknown> };
    extra.legalEntity.taxId = "123";
    const res = validateCompanyProfile(extra);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual(
        expect.objectContaining({ path: "legalEntity.taxId", kind: "invalid_value" }),
      );
    }
  });

  it("rejects non-hex SHA-256 digests and embedded data URIs on documents", () => {
    const badDoc = structuredClone(VALID_PROFILE) as {
      documentReferences: Array<{ path: string; sha256: string }>;
    };
    badDoc.documentReferences[0]!.path = "data:application/pdf;base64,JVBERi0=";
    badDoc.documentReferences[0]!.sha256 = "not-a-hash";
    const res = validateCompanyProfile(badDoc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => i.path)).toContain("documentReferences.0.path");
      expect(res.issues.map((i) => i.path)).toContain("documentReferences.0.sha256");
    }
  });

  it("runs `corridor profile validate <file>` end-to-end for valid and invalid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "corridor-profile-cli-"));
    const goodPath = join(dir, "good.json");
    const badPath = join(dir, "bad.json");
    writeFileSync(goodPath, JSON.stringify(VALID_PROFILE), "utf8");

    const invalid = structuredClone(VALID_PROFILE) as Record<string, unknown>;
    delete invalid.contacts;
    writeFileSync(badPath, JSON.stringify(invalid), "utf8");

    const loaded = loadAndValidateProfile(goodPath);
    expect(loaded.ok).toBe(true);

    const okRun = runCli(["profile", "validate", goodPath]);
    expect(okRun.status).toBe(0);
    expect(okRun.stdout).toContain("valid v0 company profile");

    const exampleRun = runCli(["profile", "validate", EXAMPLE_PATH]);
    expect(exampleRun.status).toBe(0);

    const badRun = runCli(["profile", "validate", badPath]);
    expect(badRun.status).toBe(1);
    expect(badRun.stderr).toContain("contacts");

    const usageRun = runCli(["profile"]);
    expect(usageRun.status).toBe(2);
    expect(usageRun.stderr).toContain("corridor profile validate");
  });
});
