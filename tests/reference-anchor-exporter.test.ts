import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createExporterRegistry, type BusinessProfile } from "@corridor/adapter-kit";
import { loadCorridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import {
  REFERENCE_ANCHOR_SENDER_TYPE,
  businessProfileFromCompanyProfile,
  referenceAnchorExporter,
  registerReferenceAnchorSender,
  senderAccountFor,
  type CompanyProfileV0,
} from "../packages/cli/src/reference-exporter";

const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

// The example profile #637 ships with the v0 schema is the fixture.
const SCHEMA = JSON.parse(
  readFileSync(repoFile("schemas/company-profile.v0.schema.json"), "utf8"),
);
const EXAMPLE = JSON.parse(
  readFileSync(repoFile("schemas/examples/company-profile.v0.json"), "utf8"),
) as CompanyProfileV0;

function exampleBusiness(): BusinessProfile {
  const mapped = businessProfileFromCompanyProfile(EXAMPLE);
  if (!mapped.ok) throw new Error(mapped.error.message);
  return mapped.value;
}

describe("reference-anchor onboarding exporter (#640)", () => {
  it("starts from an example profile that passes the v0 schema", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(SCHEMA);
    expect(validate(EXAMPLE), JSON.stringify(validate.errors)).toBe(true);
  });

  it("reads the v0 profile into the shared BusinessProfile", () => {
    const business = exampleBusiness();
    expect(business.legalName).toBe(EXAMPLE.legalEntity.legalName);
    expect(business.country).toBe(EXAMPLE.legalEntity.countryOfIncorporation);
    expect(business.incorporationDate).toBe(EXAMPLE.legalEntity.incorporatedAt);
    expect(business.address).toEqual(EXAMPLE.legalEntity.registeredAddress);
    const incorporated = EXAMPLE.registrationNumbers.find(
      (r) => r.country === EXAMPLE.legalEntity.countryOfIncorporation,
    );
    expect(business.registrationNumber).toBe(incorporated?.number);
    expect(business.contacts.map((c) => c.role)).toEqual(
      EXAMPLE.contacts.filter((c) => c.role !== "legal").map((c) => c.role),
    );
  });

  it("registers as an OnboardingExporter and maps onto SEP-9 organization.* keys", () => {
    const registry = createExporterRegistry();
    expect(registry.register(referenceAnchorExporter).ok).toBe(true);

    const res = registry.export("reference-anchor", exampleBusiness());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const form = res.value;
    const { legalEntity } = EXAMPLE;

    expect(form["organization.name"]).toBe(legalEntity.legalName);
    expect(form["organization.registration_number"]).toBe(
      exampleBusiness().registrationNumber,
    );
    expect(form["organization.registration_date"]).toBe(legalEntity.incorporatedAt);
    expect(form["organization.city"]).toBe(legalEntity.registeredAddress.city);
    expect(form["organization.registered_address"]).toContain(
      legalEntity.registeredAddress.line1,
    );
    // SEP-9 encodes countries as ISO-3166-1 alpha-3; the profile carries alpha-2 ("GB").
    expect(form["organization.address_country_code"]).toBe("GBR");

    // The representative fills the natural-person fields the reference server requires.
    const compliance = EXAMPLE.contacts.find((c) => c.role === "compliance")!;
    expect(form.email_address).toBe(compliance.email);
    expect(`${form.first_name} ${form.last_name}`).toBe(compliance.name);

    // No made-up keys: everything is a SEP-9 natural-person or organization.* field.
    const naturalPerson = new Set(["first_name", "last_name", "email_address"]);
    for (const key of Object.keys(form)) {
      expect(naturalPerson.has(key) || key.startsWith("organization."), key).toBe(true);
    }
  });

  it("fails with PROFILE_INCOMPLETE instead of guessing", () => {
    const noContact = { ...exampleBusiness(), contacts: [] };
    const res = referenceAnchorExporter.export(noContact);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PROFILE_INCOMPLETE");

    const onlyTreasury: CompanyProfileV0 = {
      ...EXAMPLE,
      stellarAccounts: [
        {
          network: "testnet",
          publicKey: EXAMPLE.stellarAccounts[0]!.publicKey,
          purpose: "treasury",
        },
      ],
    };
    const account = senderAccountFor(onlyTreasury, "testnet");
    expect(account.ok).toBe(false);
    if (!account.ok) expect(account.error.code).toBe("PROFILE_INCOMPLETE");
  });

  it("leaves out a country it cannot encode as alpha-3 rather than sending alpha-2", () => {
    const business = exampleBusiness();
    const res = referenceAnchorExporter.export({
      ...business,
      address: { ...business.address, country: "ZZ" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value["organization.address_country_code"]).toBeUndefined();
  });

  it("registers the sender through the SEP-31 adapter's registerCustomer", async () => {
    const corridor = loadCorridor(repoFile("corridors/reference.corridor.yaml"));
    if (!corridor.ok) throw new Error(corridor.error.message);

    const calls: Array<{ url: string; method?: string; body: Record<string, string> }> = [];
    const adapter = new Sep31Adapter(corridor.value, {
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, string>,
        });
        return new Response(JSON.stringify({ id: "sender-123" }), { status: 202 });
      }) as typeof fetch,
    });

    const form = referenceAnchorExporter.export(exampleBusiness());
    if (!form.ok) throw new Error(form.error.message);
    const account = senderAccountFor(EXAMPLE, "testnet");
    if (!account.ok) throw new Error(account.error.message);

    const registered = await registerReferenceAnchorSender(adapter, form.value, {
      account: account.value,
    });
    expect(registered).toEqual({ ok: true, value: "sender-123" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    const kycServer = (corridor.value.dest.endpoints as Record<string, unknown>).kyc_server;
    expect(calls[0]!.url).toBe(`${String(kycServer)}/customer`);
    expect(calls[0]!.body).toMatchObject({
      type: REFERENCE_ANCHOR_SENDER_TYPE,
      account: account.value,
      "organization.name": EXAMPLE.legalEntity.legalName,
    });
  });
});
