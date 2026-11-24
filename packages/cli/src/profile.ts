// Sending-business company profile validator + `corridor profile validate <file>` (#638).
//
// Validates against the versioned JSON schema from #637
// (`schemas/company-profile.v0.schema.json`) so there is one source of truth for
// the v0 profile. The schema is bundled into the CLI at build time, like
// contracts/deployments.json, and compiled once with ajv (draft 2020-12).

import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import companyProfileSchema from "../../../schemas/company-profile.v0.schema.json";

type CountryCode = string;
type IsoDate = string;

export interface PostalAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country: CountryCode;
}

export interface DocumentReference {
  readonly id: string;
  readonly title: string;
  readonly category:
    | "incorporation"
    | "licence"
    | "ownership"
    | "identity"
    | "aml_policy"
    | "address_proof"
    | "financials"
    | "other";
  /** Relative path or external vault reference; data URIs are forbidden. */
  readonly path: string;
  /** Lowercase 64-character hex SHA-256 digest of the referenced file. */
  readonly sha256: string;
  readonly date: IsoDate;
}

/** A v0 company profile, as `schemas/company-profile.v0.schema.json` defines it. */
export interface CompanyProfile {
  readonly version: "0";
  readonly legalEntity: {
    readonly legalName: string;
    readonly tradingName?: string;
    readonly entityType: string;
    readonly countryOfIncorporation: CountryCode;
    readonly incorporatedAt: IsoDate;
    readonly registeredAddress: PostalAddress;
    readonly operatingAddress?: PostalAddress;
    readonly website?: string;
  };
  readonly registrationNumbers: ReadonlyArray<{
    readonly country: CountryCode;
    readonly authority: string;
    readonly number: string;
    readonly issuedAt?: IsoDate;
    readonly documentRefId?: string;
  }>;
  readonly licences: ReadonlyArray<{
    readonly jurisdiction: CountryCode;
    readonly licenceType: string;
    readonly licenceNumber: string;
    readonly regulator: string;
    readonly status: "active" | "pending" | "exempt" | "expired" | "revoked";
    readonly validUntil?: IsoDate;
    readonly documentRefId?: string;
  }>;
  readonly ownership: {
    readonly beneficialOwners: ReadonlyArray<{
      readonly fullName: string;
      readonly ownershipPercent: number;
      readonly nationality: CountryCode;
      readonly countryOfResidence: CountryCode;
      readonly isPep?: boolean;
      readonly role?: string;
      readonly documentRefId?: string;
    }>;
    readonly directors: ReadonlyArray<{
      readonly fullName: string;
      readonly role: string;
      readonly nationality: CountryCode;
      readonly countryOfResidence: CountryCode;
      readonly appointedAt?: IsoDate;
      readonly documentRefId?: string;
    }>;
  };
  readonly amlCft: {
    readonly policyVersion: string;
    readonly policyDate: IsoDate;
    readonly complianceOfficer: {
      readonly name: string;
      readonly title: string;
      readonly email: string;
      readonly phone?: string;
    };
    readonly screeningProviders?: readonly string[];
    readonly sanctionsRegimes: readonly string[];
    readonly transactionMonitoringSummary: string;
    readonly documentRefId?: string;
  };
  readonly stellarAccounts: ReadonlyArray<{
    readonly network: "public" | "testnet";
    readonly publicKey: string;
    readonly purpose: "settlement" | "sep10_auth" | "treasury" | "distribution" | "fee";
    readonly label?: string;
  }>;
  readonly contacts: ReadonlyArray<{
    readonly role: "primary" | "compliance" | "technical" | "finance" | "legal";
    readonly name: string;
    readonly email: string;
    readonly phone?: string;
  }>;
  readonly documentReferences: readonly DocumentReference[];
}

export interface ProfileValidationIssue {
  readonly path: string;
  readonly kind: "missing" | "invalid_type" | "invalid_value" | "io";
  readonly message: string;
}

export type ProfileValidationResult =
  | { readonly ok: true; readonly profile: CompanyProfile }
  | { readonly ok: false; readonly issues: readonly ProfileValidationIssue[] };

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile<CompanyProfile>(companyProfileSchema);

/** `/legalEntity/registeredAddress/0` → `legalEntity.registeredAddress.0`, plus a trailing key. */
function issuePath(instancePath: string, key?: string): string {
  const parts = instancePath
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (key !== undefined) parts.push(key);
  return parts.length > 0 ? parts.join(".") : "<root>";
}

function toIssue(error: ErrorObject): ProfileValidationIssue {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") {
    const missing = String(params.missingProperty);
    return {
      path: issuePath(error.instancePath, missing),
      kind: "missing",
      message: `missing required property "${missing}"`,
    };
  }
  if (error.keyword === "additionalProperties") {
    const extra = String(params.additionalProperty);
    return {
      path: issuePath(error.instancePath, extra),
      kind: "invalid_value",
      message: `unknown property "${extra}" is not allowed`,
    };
  }
  return {
    path: issuePath(error.instancePath),
    kind: error.keyword === "type" ? "invalid_type" : "invalid_value",
    message: error.message ?? `failed ${error.keyword}`,
  };
}

export function validateCompanyProfile(raw: unknown): ProfileValidationResult {
  if (validateSchema(raw)) {
    return { ok: true, profile: raw };
  }
  return { ok: false, issues: (validateSchema.errors ?? []).map(toIssue) };
}

export function loadAndValidateProfile(filePath: string): ProfileValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: filePath,
          kind: "io",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  return validateCompanyProfile(raw);
}

export const PROFILE_USAGE = "usage: corridor profile validate <file.json> [--json]";

export type ProfileArgs =
  | { readonly ok: true; readonly file: string; readonly json: boolean }
  | { readonly ok: false; readonly error: string };

export function parseProfileArgs(args: readonly string[]): ProfileArgs {
  if (args[0] !== "validate") {
    return { ok: false, error: PROFILE_USAGE };
  }
  let file: string | undefined;
  let json = false;
  for (const arg of args.slice(1)) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `error: unknown option "${arg}"` };
    } else if (!file) {
      file = arg;
    } else {
      return { ok: false, error: `error: unexpected argument "${arg}"` };
    }
  }
  if (!file) {
    return { ok: false, error: PROFILE_USAGE };
  }
  return { ok: true, file, json };
}

export function formatProfileValidation(
  file: string,
  result: ProfileValidationResult,
): string {
  if (result.ok) {
    return `✓ ${file} is a valid v${result.profile.version} company profile (${result.profile.legalEntity.legalName})`;
  }
  const lines = [`✗ ${file} failed validation (${result.issues.length} issue(s)):`];
  for (const issue of result.issues) {
    lines.push(`  - ${issue.path} [${issue.kind}]: ${issue.message}`);
  }
  return lines.join("\n");
}
