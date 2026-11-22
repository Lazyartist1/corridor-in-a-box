/**
 * contracts/deployments.json against contracts/deployments.schema.json.
 *
 * Consumers (the CLI, the dashboard, the examples) read the committed file
 * without validating it, so a malformed hash or a half-filled mainnet entry
 * would only surface as a wrong lookup at runtime. This keeps the shape honest.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

// The file is walked and mutated dynamically to build invalid variants.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const read = (name: string): Json =>
  JSON.parse(readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8"));

const schema = read("deployments.schema.json");
const deployments = read("deployments.json");

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const clone = (): Json => JSON.parse(JSON.stringify(deployments));

function errorsOf(doc: Json): string {
  validate(doc);
  return ajv.errorsText(validate.errors);
}

const REGISTRY_ID = "CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4";
const ATTESTER_ID = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";

describe("contracts/deployments.json", () => {
  it("validates against the schema", () => {
    expect(validate(deployments), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("records the testnet upgrade of both contracts", () => {
    const upgrades: Json[] = deployments.testnet.upgrades;
    expect(upgrades.map((u) => u.contract).sort()).toEqual(["attester", "registry"]);
    for (const u of upgrades) expect(u.date).toBe("2026-11-17");
  });

  it("lists each network's upgrades oldest first", () => {
    for (const net of ["testnet", "public"]) {
      const ledgers: number[] = (deployments[net].upgrades ?? []).map((u: Json) => u.ledger);
      expect(ledgers, net).toEqual([...ledgers].sort((a, b) => a - b));
    }
  });

  it("keeps mainnet valid while it is not deployed", () => {
    expect(deployments.public.registry).toBeNull();
    expect(deployments.public.attester).toBeNull();
    expect(validate(deployments)).toBe(true);
  });
});

describe("deployments schema rejects", () => {
  it("a missing wasm hash", () => {
    const doc = clone();
    delete doc.testnet.upgrades[0].wasmHash;
    expect(errorsOf(doc)).toContain("wasmHash");
  });

  it("a missing transaction hash", () => {
    const doc = clone();
    delete doc.testnet.upgrades[1].txHash;
    expect(errorsOf(doc)).toContain("txHash");
  });

  it("a missing date", () => {
    const doc = clone();
    delete doc.testnet.upgrades[0].date;
    expect(errorsOf(doc)).toContain("date");
  });

  it.each([
    ["too short", "2db79e0e"],
    ["upper case", "2DB79E0E0EB4E69C923BEC6C87C514CE5C60434B0CA2930680660B83C3E88F9D"],
    ["not hex", "zz".repeat(32)],
  ])("a malformed wasm hash (%s)", (_name, hash) => {
    const doc = clone();
    doc.testnet.upgrades[0].wasmHash = hash;
    expect(validate(doc)).toBe(false);
  });

  it("a malformed transaction hash", () => {
    const doc = clone();
    doc.testnet.upgrades[0].txHash = "not-a-hash";
    expect(validate(doc)).toBe(false);
  });

  it("an impossible date", () => {
    const doc = clone();
    doc.testnet.upgrades[0].date = "2026-02-31";
    expect(validate(doc)).toBe(false);
  });

  it("an unknown contract name", () => {
    const doc = clone();
    doc.testnet.upgrades[0].contract = "router";
    expect(validate(doc)).toBe(false);
  });

  it("a malformed contract address", () => {
    const doc = clone();
    doc.testnet.registry = "not-a-contract";
    expect(validate(doc)).toBe(false);
  });

  it("a deployed contract with no deployedAt", () => {
    const doc = clone();
    doc.public.registry = REGISTRY_ID;
    doc.public.attester = ATTESTER_ID;
    expect(errorsOf(doc)).toContain("deployedAt");
  });

  it("upgrades recorded for a network with nothing deployed", () => {
    const doc = clone();
    doc.public.upgrades = [doc.testnet.upgrades[0]];
    expect(validate(doc)).toBe(false);
  });

  it("an unexpected field on an upgrade", () => {
    const doc = clone();
    doc.testnet.upgrades[0].note = "free text";
    expect(validate(doc)).toBe(false);
  });
});

describe("deployments schema accepts", () => {
  it("a real mainnet entry once one is recorded", () => {
    const doc = clone();
    doc.public.registry = REGISTRY_ID;
    doc.public.attester = ATTESTER_ID;
    doc.public.deployedAt = "2026-12-01";
    doc.public.upgrades = [];
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
  });
});
