// Onboarding exporter for the self-hosted SDF Anchor Platform reference server
// (`scripts/reference-anchor.sh`, SEP server at http://localhost:8080) (#640).
//
// Built on what already ships, in three steps:
//   1. `businessProfileFromCompanyProfile()` reads a v0 company profile (#637,
//      `schemas/company-profile.v0.schema.json`) into adapter-kit's shared
//      `BusinessProfile`, the type every onboarding exporter takes (#639).
//   2. `referenceAnchorExporter` is an `OnboardingExporter` that maps that profile onto
//      the SEP-12 fields the reference server takes for a `sep31-sender`: the
//      representative's SEP-9 natural-person fields, and the business under the SEP-9
//      `organization.*` keys.
//   3. `registerReferenceAnchorSender()` submits the form through the SEP-31 adapter's
//      `registerCustomer` (SEP-12 `PUT /customer`), so SEP-10 auth and error handling are
//      the same as for every other registration.
//
// Document files are never uploaded: their path, sha256 and date stay in the profile.

import type {
  BusinessProfile,
  ExporterError,
  OnboardingExporter,
  ReceiverForm,
} from "@corridor/adapter-kit";
import { toAlpha3 } from "@corridor/probe";
import type { Sep31Adapter } from "@corridor/sep31";
import { err, ok, type Outcome } from "@corridor/types";

/** The SEP-12 customer type the reference server registers a sending business under. */
export const REFERENCE_ANCHOR_SENDER_TYPE = "sep31-sender";

/**
 * The parts of a v0 company profile (`schemas/company-profile.v0.schema.json`) this
 * exporter reads. Any profile that passes the schema satisfies it.
 */
export interface CompanyProfileV0 {
  readonly version: "0";
  readonly legalEntity: {
    readonly legalName: string;
    readonly tradingName?: string;
    readonly countryOfIncorporation: string;
    readonly incorporatedAt: string;
    readonly registeredAddress: {
      readonly line1: string;
      readonly line2?: string;
      readonly city: string;
      readonly region?: string;
      readonly postalCode?: string;
      readonly country: string;
    };
    readonly website?: string;
  };
  readonly registrationNumbers: ReadonlyArray<{
    readonly country: string;
    readonly authority: string;
    readonly number: string;
  }>;
  readonly stellarAccounts: ReadonlyArray<{
    readonly network: "public" | "testnet";
    readonly publicKey: string;
    readonly purpose: "settlement" | "sep10_auth" | "treasury" | "distribution" | "fee";
  }>;
  readonly contacts: ReadonlyArray<{
    readonly role: "primary" | "compliance" | "technical" | "finance" | "legal";
    readonly name: string;
    readonly email: string;
    readonly phone?: string;
  }>;
}

type BusinessContact = BusinessProfile["contacts"][number];

function incomplete(message: string): Outcome<never, ExporterError> {
  return err({ code: "PROFILE_INCOMPLETE", message });
}

/**
 * Read a v0 company profile into adapter-kit's `BusinessProfile`. The registration
 * number is the one issued in the country of incorporation, falling back to the first.
 * `legal` contacts are dropped: `BusinessProfile` has no such role.
 */
export function businessProfileFromCompanyProfile(
  profile: CompanyProfileV0,
): Outcome<BusinessProfile, ExporterError> {
  if (profile.version !== "0") {
    return incomplete(`unsupported company profile version "${String(profile.version)}"`);
  }
  const { legalEntity } = profile;
  const registration =
    profile.registrationNumbers.find(
      (r) => r.country === legalEntity.countryOfIncorporation,
    ) ?? profile.registrationNumbers[0];
  if (!registration) {
    return incomplete("company profile has no registrationNumbers entry");
  }
  const contacts = profile.contacts.filter(
    (c): c is CompanyProfileV0["contacts"][number] & BusinessContact => c.role !== "legal",
  );
  return ok<BusinessProfile>({
    legalName: legalEntity.legalName,
    ...(legalEntity.tradingName ? { tradingName: legalEntity.tradingName } : {}),
    registrationNumber: registration.number,
    country: legalEntity.countryOfIncorporation,
    incorporationDate: legalEntity.incorporatedAt,
    ...(legalEntity.website ? { website: legalEntity.website } : {}),
    address: legalEntity.registeredAddress,
    contacts: contacts.map(({ role, name, email, phone }) => ({
      role,
      name,
      email,
      ...(phone ? { phone } : {}),
    })),
  });
}

/**
 * The Stellar account the business authenticates with on `network`: its `sep10_auth`
 * account, else its `settlement` account. This is the `account` the SEP-12 customer
 * is registered under.
 */
export function senderAccountFor(
  profile: CompanyProfileV0,
  network: "public" | "testnet",
): Outcome<string, ExporterError> {
  const onNetwork = profile.stellarAccounts.filter((a) => a.network === network);
  const account =
    onNetwork.find((a) => a.purpose === "sep10_auth") ??
    onNetwork.find((a) => a.purpose === "settlement");
  if (!account) {
    return incomplete(
      `company profile has no sep10_auth or settlement Stellar account on ${network}`,
    );
  }
  return ok(account.publicKey);
}

function splitName(fullName: string): { first: string; last: string } | undefined {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/**
 * Maps a `BusinessProfile` onto the reference server's `sep31-sender` SEP-12 fields.
 * The representative (compliance contact, else primary) fills the SEP-9 natural-person
 * fields the reference server requires; the business goes under `organization.*`.
 * Countries are sent as ISO-3166-1 alpha-3, as SEP-9 encodes them.
 */
export const referenceAnchorExporter: OnboardingExporter = {
  id: "reference-anchor",
  receiver: "SDF Anchor Platform reference server",
  export(profile: BusinessProfile): Outcome<ReceiverForm, ExporterError> {
    const representative =
      profile.contacts.find((c) => c.role === "compliance") ??
      profile.contacts.find((c) => c.role === "primary");
    if (!representative) {
      return incomplete("the reference anchor requires a compliance or primary contact");
    }
    const name = splitName(representative.name);
    if (!name) {
      return incomplete(
        `the reference anchor requires a first and last name for ${representative.name || "the representative"}`,
      );
    }
    const primary = profile.contacts.find((c) => c.role === "primary") ?? representative;
    const { address } = profile;
    const countryAlpha3 = toAlpha3(address.country);

    const form: Record<string, string> = {
      first_name: name.first,
      last_name: name.last,
      email_address: representative.email,
      "organization.name": profile.legalName,
      "organization.registration_number": profile.registrationNumber,
      "organization.registered_address": [
        address.line1,
        address.line2,
        address.city,
        address.region,
        address.postalCode,
        address.country,
      ]
        .filter(Boolean)
        .join(", "),
      "organization.city": address.city,
      "organization.email": primary.email,
    };
    if (profile.incorporationDate) {
      form["organization.registration_date"] = profile.incorporationDate;
    }
    if (countryAlpha3) form["organization.address_country_code"] = countryAlpha3;
    if (address.region) form["organization.state_or_province"] = address.region;
    if (address.postalCode) form["organization.postal_code"] = address.postalCode;
    if (profile.website) form["organization.website"] = profile.website;
    if (primary.phone) form["organization.phone"] = primary.phone;
    if (profile.taxId) form["organization.VAT_number"] = profile.taxId;
    return ok<ReceiverForm>(form);
  },
};

/**
 * Register the sending business with the reference anchor through the SEP-31 adapter's
 * `registerCustomer` (SEP-12 `PUT /customer`). Returns the customer id to use as
 * `SENDER_SEP12_ID`.
 */
export function registerReferenceAnchorSender(
  adapter: Pick<Sep31Adapter, "registerCustomer">,
  form: ReceiverForm,
  opts: { readonly account: string },
): Promise<Outcome<string>> {
  return adapter.registerCustomer(
    { ...form },
    { type: REFERENCE_ANCHOR_SENDER_TYPE, account: opts.account },
  );
}
