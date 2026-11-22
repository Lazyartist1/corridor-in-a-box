import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const schema = JSON.parse(
  readFileSync(new URL("../schemas/company-profile.v0.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const example = JSON.parse(
  readFileSync(
    new URL("../schemas/examples/company-profile.v0.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("company profile schema v0 (#637)", () => {
  it("validates the example company profile", () => {
    const ok = validate(example);
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects wrong schema version or missing required top-level fields", () => {
    expect(validate({ ...example, version: "1" })).toBe(false);

    const withoutAml = structuredClone(example);
    delete withoutAml.amlCft;
    expect(validate(withoutAml)).toBe(false);
  });

  it("rejects embedded document payloads and malformed SHA-256 digests", () => {
    const refs = example.documentReferences as Array<Record<string, unknown>>;

    const withDataUri = structuredClone(example) as {
      documentReferences: Array<Record<string, unknown>>;
    };
    withDataUri.documentReferences[0] = {
      ...refs[0],
      path: "data:application/pdf;base64,JVBERi0=",
    };
    expect(validate(withDataUri)).toBe(false);

    const withEmbeddedFile = structuredClone(example) as {
      documentReferences: Array<Record<string, unknown>>;
    };
    withEmbeddedFile.documentReferences[0] = {
      ...refs[0],
      contentBase64: "JVBERi0=",
    };
    expect(validate(withEmbeddedFile)).toBe(false);

    const withBadSha = structuredClone(example) as {
      documentReferences: Array<Record<string, unknown>>;
    };
    withBadSha.documentReferences[0] = {
      ...refs[0],
      sha256: "not-a-sha256",
    };
    expect(validate(withBadSha)).toBe(false);
  });

  it("rejects malformed Stellar account public keys", () => {
    const accounts = example.stellarAccounts as Array<Record<string, unknown>>;
    const bad = structuredClone(example) as {
      stellarAccounts: Array<Record<string, unknown>>;
    };
    bad.stellarAccounts[0] = {
      ...accounts[0],
      publicKey: "not-a-stellar-key",
    };
    expect(validate(bad)).toBe(false);
  });
});
