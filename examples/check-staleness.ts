// Check that every anchor domain in contracts/anchors.json has an attestation
// on chain and that none exceeds the staleness threshold.
//
//   pnpm registry:staleness
//   pnpm registry:staleness --threshold 17280 --json
//
// Exits 1 if any domain is stale or never attested. Used as the final guard in
// .github/workflows/attest-anchors.yml so scheduled runs fail when the registry
// goes stale for any reason (reverting attestations, skipped domains, missing
// secrets, or untracked anchors).

import { readFileSync } from "node:fs";
import {
  AnchorRegistry,
  findStale,
  DEFAULT_MAX_STALENESS_LEDGERS,
  type StalenessRecord,
} from "@corridor/registry";

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

interface AnchorsJson {
  domains?: string[];
  anchors?: Array<{ domain: string }>;
}

const USAGE = [
  "usage: pnpm registry:staleness [--threshold <ledgers>] [--json]",
  "",
  `  --threshold <n>    max allowed staleness in ledgers (default: ${DEFAULT_MAX_STALENESS_LEDGERS} ≈ 2 days)`,
  "  --json             emit findings as JSON",
].join("\n");

function parseArgs(argv: readonly string[]): {
  threshold: number;
  json: boolean;
} {
  let threshold = process.env.MAX_STALENESS_LEDGERS
    ? Number(process.env.MAX_STALENESS_LEDGERS)
    : DEFAULT_MAX_STALENESS_LEDGERS;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--threshold") {
      const val = argv[++i];
      if (!val || Number.isNaN(Number(val)) || Number(val) <= 0) {
        console.error(`invalid --threshold: ${val}\n\n${USAGE}`);
        process.exit(2);
      }
      threshold = Number(val);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  return { threshold, json };
}

async function main(): Promise<void> {
  const { threshold, json } = parseArgs(process.argv.slice(2));

  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const deployments = JSON.parse(
    readFileSync(new URL("../contracts/deployments.json", import.meta.url), "utf8"),
  ) as Deployments;

  const cfg = deployments[network];
  if (!cfg?.registry) {
    console.error(`✗ no registry deployed on ${network} (see contracts/deployments.json)`);
    process.exit(1);
  }

  const anchorsDoc = JSON.parse(
    readFileSync(new URL("../contracts/anchors.json", import.meta.url), "utf8"),
  ) as AnchorsJson;

  const domains = anchorsDoc.domains ?? anchorsDoc.anchors?.map((a) => a.domain) ?? [];
  if (domains.length === 0) {
    console.error("✗ no domains found in contracts/anchors.json");
    process.exit(1);
  }

  const registry = new AnchorRegistry({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.registry,
    networkPassphrase: cfg.networkPassphrase,
  });

  if (!json) {
    console.log(
      `Checking ${domains.length} domains against registry ${cfg.registry} on ${network} (threshold: ${threshold} ledgers)\n`,
    );
  }

  const records: StalenessRecord[] = [];
  for (const domain of domains) {
    try {
      const age = await registry.staleness(domain);
      records.push({ domain, staleness: age });
    } catch {
      // Contract reverted (e.g. NotFound) — domain was never attested
      records.push({ domain, staleness: null });
    }
  }

  const staleFindings = findStale(records, threshold);

  if (json) {
    console.log(
      JSON.stringify(
        {
          network,
          registry: cfg.registry,
          threshold,
          total: domains.length,
          staleCount: staleFindings.length,
          ok: staleFindings.length === 0,
          findings: staleFindings,
          records,
        },
        null,
        2,
      ),
    );
  } else {
    for (const record of records) {
      if (record.staleness === null || record.staleness === undefined) {
        console.error(`✗ ${record.domain}: NEVER ATTESTED (NotFound in contract)`);
        console.error(`::error::Anchor domain ${record.domain} was never attested on chain`);
      } else if (record.staleness > threshold) {
        console.error(
          `✗ ${record.domain}: STALE (${record.staleness} ledgers old > ${threshold} threshold)`,
        );
        console.error(
          `::error::Anchor domain ${record.domain} is stale (${record.staleness} ledgers old > ${threshold} threshold)`,
        );
      } else {
        console.log(`✓ ${record.domain}: fresh (${record.staleness} ledgers old)`);
      }
    }
    console.log("");
  }

  if (staleFindings.length > 0) {
    if (!json) {
      console.error(
        `✗ Registry staleness check failed: ${staleFindings.length} of ${domains.length} domain(s) are stale or missing.`,
      );
    }
    process.exit(1);
  }

  if (!json) {
    console.log(`✓ All ${domains.length} domain(s) are fresh in the on-chain registry.`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
