// Proves crash-resume against the LIVE reference stack: the service process is
// killed (SIGKILL, no draining) after the payment has settled on testnet, a new
// process is started on the same Postgres, and the run must reach `completed`
// with the SAME single Stellar transaction hash.
//
//   scripts/reference-anchor.sh up
//   DATABASE_URL=postgres://... CORRIDOR_SIGNER_SECRET=S... pnpm verify:crash-resume
//
// This is the live counterpart of tests/integration/crash-resume.test.ts and
// the failure-path sibling of `pnpm verify:corridor`:
//
//   crash-resume.test.ts   rewinds a stored row and calls execute() a second time.
//   chaos tests            mocks only.
//   verify:crash-resume    a real process kill against a real anchor and Horizon.
//
// The sequence:
//
//   1. start `examples/run-service.ts` on Postgres, POST /payments (not awaited)
//   2. poll GET /payments/:key until the run holds a settlement tx hash and is
//      not yet `completed`
//   3. kill -9 the service
//   4. start payout-watch (the anchor only pays out once called, so the run
//      cannot finish while the service is down), start the service again
//   5. POST the same body: the engine resumes from the stored state
//   6. assert `completed`, the same tx hash, and exactly one matching
//      payment transaction from the signer on Horizon
//
// The outcome is appended to $GITHUB_STEP_SUMMARY when it is set.
//
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   DATABASE_URL=postgres://...   the service's durable store (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   SERVICE_PORT=8787             where the service under test listens
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   AMOUNT=...                    default 10.00
//   LOG_DIR=crash-resume-logs     service and payout-watch logs

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import {
  assertAssetQuotable,
  pinToReferenceAnchor,
  preflightDoctor,
  registerSep12Customer,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
  EXIT_NOT_COMPLETED,
} from "../packages/cli/src/wire.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = (process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org").replace(
  /\/+$/,
  "",
);
const AMOUNT = process.env.AMOUNT ?? "10.00";
const PORT = Number(process.env.SERVICE_PORT ?? "8787");
const BASE = `http://127.0.0.1:${PORT}`;
const LOG_DIR = process.env.LOG_DIR ?? "crash-resume-logs";

/** How long each phase may take before the run is declared stuck. */
const SETTLE_WAIT_MS = 180_000;
const RESUME_WAIT_MS = 240_000;
const READY_WAIT_MS = 60_000;
const POLL_MS = 150;

const root = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Failure extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_NOT_COMPLETED,
  ) {
    super(message);
  }
}

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Failure(`missing required env var ${name}. ${hint}`, EXIT_MISSING_ENV);
  }
  return v;
}

// -- evidence ----------------------------------------------------------------

const summary: Array<[string, string]> = [];
const note = (step: string, detail: string): void => {
  summary.push([step, detail]);
  console.log(`  ${step}: ${detail}`);
};

function writeSummary(outcome: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const rows = summary.map(([k, v]) => `| ${k} | ${v.replace(/[\\|]/g, "\\$&")} |`).join("\n");
  appendFileSync(
    path,
    `### Live crash-resume: ${outcome}\n\n| Step | Result |\n| --- | --- |\n${rows}\n\n`,
  );
}

// -- child processes ---------------------------------------------------------

const children = new Set<ChildProcess>();

function spawnLogged(
  cmd: string,
  args: string[],
  logName: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(join(LOG_DIR, logName));
  const child = spawn(cmd, args, { cwd: root("."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function startService(env: NodeJS.ProcessEnv, logName: string): ChildProcess {
  return spawnLogged(
    process.execPath,
    ["--import", "tsx", root("examples/run-service.ts")],
    logName,
    env,
  );
}

async function waitReady(service: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) {
      throw new Failure(`the service exited early (code ${service.exitCode}); see ${LOG_DIR}`);
    }
    try {
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Failure(`the service was not ready within ${READY_WAIT_MS / 1000}s`);
}

// -- the service API ---------------------------------------------------------

interface RunView {
  state?: string;
  stellarTxHash?: string;
  transactionId?: string;
  error?: string;
}

async function getRun(key: string, apiKey: string): Promise<RunView | undefined> {
  const r = await fetch(`${BASE}/payments/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Failure(`GET /payments/${key} answered ${r.status}`);
  return (await r.json()) as RunView;
}

// -- Horizon -----------------------------------------------------------------

interface HorizonTx {
  hash: string;
  successful: boolean;
  source_account: string;
  memo?: string;
  created_at: string;
}

async function horizon<T>(path: string): Promise<T> {
  const r = await fetch(`${HORIZON}${path}`);
  if (!r.ok) throw new Failure(`Horizon ${path} answered ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Successful transactions from the signer carrying the settlement's memo since
 * the run began. The memo is the anchor's per-transaction id, so a second
 * on-chain payment for the same run would show up here as a second entry.
 */
async function countSettlementTxs(
  signer: string,
  txHash: string,
  sinceMs: number,
): Promise<number> {
  const tx = await horizon<HorizonTx>(`/transactions/${txHash}`);
  const page = await horizon<{ _embedded: { records: HorizonTx[] } }>(
    `/accounts/${signer}/transactions?order=desc&limit=100`,
  );
  const since = sinceMs - 120_000;
  return page._embedded.records.filter(
    (r) =>
      r.successful &&
      r.source_account === signer &&
      Date.parse(r.created_at) >= since &&
      (tx.memo === undefined || r.memo === tx.memo),
  ).length;
}

// -- the scenario ------------------------------------------------------------

async function run(): Promise<void> {
  const signerSecret = requireEnv(
    "CORRIDOR_SIGNER_SECRET",
    "A testnet distribution account seed, never a mainnet one (docs/key-management.md).",
  );
  const databaseUrl = requireEnv(
    "DATABASE_URL",
    "The service needs a durable store for a restart to resume from.",
  );

  const manifestPath = ((): string => {
    const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
    return p.startsWith("/") ? p : root(p);
  })();
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) throw new Failure(`manifest error: ${loaded.error.message}`, EXIT_MANIFEST);
  if (loaded.value.settlement.network === "public") {
    throw new Failure(
      `corridor "${loaded.value.id}" settles on MAINNET (network=public). This scenario ` +
        `kills a service mid-payment and will not run against real money.`,
      EXIT_REFUSED,
    );
  }
  const corridor = pinToReferenceAnchor(loaded.value, ANCHOR);

  const doc = preflightDoctor();
  if (!doc.ok) {
    throw new Failure(
      doc.error ??
        `the reference anchor is not fit to run a corridor (doctor exit ${doc.status})`,
      EXIT_STACK_UNFIT,
    );
  }
  const quotable = await assertAssetQuotable(corridor, ANCHOR);
  if (!quotable.ok) {
    throw new Failure(
      quotable.error ?? "the anchor does not quote the bridge asset",
      quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT,
    );
  }

  // The service serves every manifest in its corridors dir. Hand it only this
  // one so an unrelated manifest cannot fail the boot.
  const corridorsDir = mkdtempSync(join(tmpdir(), "crash-resume-corridors-"));
  copyFileSync(manifestPath, join(corridorsDir, "reference.corridor.yaml"));

  // SEP-12 ids for both parties, registered by the sending side like
  // verify-corridor does. The engine only carries the returned ids.
  const wired = wireCorridorDeps(corridor, { signerSecret, horizonUrl: HORIZON });
  const register = async (role: "receiver" | "sender", type: string): Promise<string> => {
    const reg = await registerSep12Customer(wired.adapter, role, type);
    if (!reg.ok) {
      throw new Failure(`SEP-12 ${role} registration failed: ${reg.error.code}`);
    }
    return reg.value;
  };
  const senderSep12Id = await register("sender", corridor.compliance.sep12_sender_type);
  const recipientSep12Id = await register("receiver", corridor.compliance.sep12_receiver_type);

  const apiKey = randomBytes(16).toString("hex");
  const idempotencyKey = `crash-resume-live-${Date.now()}`;
  const body = JSON.stringify({
    idempotencyKey,
    corridorId: corridor.id,
    sender: {
      id: "sender-1",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: "recipient-1",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: AMOUNT },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  });
  const post = (signal?: AbortSignal): Promise<Response> =>
    fetch(`${BASE}/payments`, {
      signal,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
    });

  const serviceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: databaseUrl,
    CORRIDORS_DIR: corridorsDir,
    CORRIDOR_API_KEYS: apiKey,
    CORRIDOR_SIGNER: "local",
    CORRIDOR_SIGNER_SECRET: signerSecret,
    HORIZON_URL: HORIZON,
    // The runner's mainnet guard stays closed.
    CORRIDOR_ALLOW_MAINNET: "",
  };

  console.log(`\nlive crash-resume of "${corridor.id}" against ${ANCHOR}`);
  console.log(`  signer:  ${wired.signer.publicKey}`);
  const asset = corridor.settlement.bridge_asset;
  console.log(`  key:     ${idempotencyKey} (${AMOUNT} ${asset})\n`);
  note("signer", wired.signer.publicKey);
  note("idempotency key", idempotencyKey);

  const startedAt = Date.now();

  // 1. First process: begin the payment and do not wait for it.
  const first = startService(serviceEnv, "service-1.log");
  await waitReady(first);
  let firstReturned = false;
  void post()
    .then(() => {
      firstReturned = true;
    })
    .catch(() => {
      // The connection dies with the process; that is the point.
    });

  // 2. Wait until the payment is on chain but the run is not finished.
  let before: RunView | undefined;
  const settleDeadline = Date.now() + SETTLE_WAIT_MS;
  while (Date.now() < settleDeadline) {
    if (first.exitCode !== null) {
      throw new Failure(`the first service exited early (code ${first.exitCode})`);
    }
    before = await getRun(idempotencyKey, apiKey);
    if (before?.state === "completed" || before?.state === "failed" || firstReturned) {
      throw new Failure(
        `the run reached "${before?.state ?? "a response"}" before the kill, so no ` +
          `crash was exercised (error: ${before?.error ?? "none"})`,
      );
    }
    if (before?.stellarTxHash) break;
    await sleep(POLL_MS);
  }
  if (!before?.stellarTxHash) {
    throw new Failure(`no settlement appeared within ${SETTLE_WAIT_MS / 1000}s`);
  }
  const txHash = before.stellarTxHash;
  note("state at kill", `${before.state}, tx ${txHash}`);

  // 3. Kill it without warning.
  first.kill("SIGKILL");
  await exited(first);
  note("service-1", "killed with SIGKILL");

  // 4. The anchor pays out only when told to, so start that now: the run can
  //    only finish after the restart. Then bring the service back.
  const watcher = root("scripts/reference-anchor.sh");
  spawnLogged("bash", [watcher, "payout-watch"], "payout-watch.log", process.env);
  const second = startService(serviceEnv, "service-2.log");
  await waitReady(second);

  const stored = await getRun(idempotencyKey, apiKey);
  note("state after restart", `${stored?.state ?? "missing"}, tx ${stored?.stellarTxHash}`);
  if (!stored) throw new Failure("the run was not found after the restart");
  if (stored.stellarTxHash !== txHash) {
    throw new Failure(`the tx hash changed across the restart: ${stored.stellarTxHash}`);
  }

  // 5. Same body, same key: the engine must resume rather than start over.
  const resumed = await post(AbortSignal.timeout(RESUME_WAIT_MS)).catch(() => {
    throw new Failure(`the resumed run did not finish within ${RESUME_WAIT_MS / 1000}s`);
  });
  const result = (await resumed.json()) as RunView & { message?: string };
  if (resumed.status !== 200) {
    throw new Failure(
      `resume answered ${resumed.status}: ${result.error ?? ""} ${result.message ?? ""}`,
    );
  }
  note("resume", `HTTP ${resumed.status}, state ${result.state}`);

  // 6. The assertions.
  if (result.state !== "completed") {
    throw new Failure(`terminal state is "${result.state}", not "completed"`);
  }
  if (result.stellarTxHash !== txHash) {
    throw new Failure(`resume reported tx ${result.stellarTxHash}, expected ${txHash}`);
  }
  const final = await getRun(idempotencyKey, apiKey);
  if (final?.state !== "completed" || final.stellarTxHash !== txHash) {
    throw new Failure(`stored run is ${final?.state} / ${final?.stellarTxHash} after resume`);
  }
  note("final state", `completed with tx ${txHash}`);

  const count = await countSettlementTxs(wired.signer.publicKey, txHash, startedAt);
  note("payments on Horizon", `${count} (expected 1)`);
  if (count !== 1) {
    throw new Failure(`Horizon shows ${count} settlement transactions for this run, not 1`);
  }
  note("explorer", `https://stellar.expert/explorer/testnet/tx/${txHash}`);

  rmSync(corridorsDir, { recursive: true, force: true });
  console.log(`\n✓ resumed after a kill to completed with exactly one transaction`);
}

async function main(): Promise<void> {
  let code = 0;
  try {
    await run();
    writeSummary("passed");
  } catch (e) {
    const failure = e instanceof Failure ? e : undefined;
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n✗ ${message}`);
    note("failure", message);
    writeSummary("failed");
    code = failure?.exitCode ?? 1;
  } finally {
    for (const c of children) c.kill("SIGKILL");
  }
  process.exit(code);
}

void main();
