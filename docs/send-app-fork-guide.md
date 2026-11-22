# Fork the send app: a starter guide

The **send app** is the `web/` showcase: a sender picks a corridor, enters an
amount, sends testnet funds and watches the payment walk
`created → quoted → compliant → opened → verifying → settling → settled →
reconciled → completed`. It is the "fork this app" starting point for a business
that wants its own face on the flow.

**It is testnet only.** No real money moves in it, and nothing in this repo
licenses you to move any. This guide covers copying it, rebranding it, pointing
it at a real `@corridor/service`, and the two things a fork cannot copy.

## What you get, and what you do not

| You get (Apache-2.0)                                  | You do not get                                             |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| The Next.js app in `web/`, editable and rebrandable   | A money-transmission licence, or any regulatory approval   |
| A working `/payments` flow on the real engine, mocked | An anchor relationship, or the right to use anyone's rails |
| The server route that proxies to `@corridor/service`  | A production signing key, or a safe place to keep one      |
| The dashboard, liveness labels and docs pages         | Approval, endorsement, or support from the maintainers     |

## Before you fork: the two things a fork cannot copy

### 1. A licence to move real money

Apache-2.0 gives you copyright and patent rights **in the code**. It says
nothing about your right to hold customer funds, transmit money, or provide a
payment service. In most jurisdictions that needs a licence or registration from
the financial regulator (remittance, money transmitter, payment institution —
the name varies), plus an AML/KYC programme, safeguarding of customer funds,
record-keeping and reporting.

The demo in this repo is not a licensed service and contains no compliance
programme: the "KYC" is a mock anchor accepting a hard-coded sender, and the
"payment" is a state machine with in-memory adapters. If you intend to touch
real money, get your own legal and compliance advice before you build, not after
you launch. This guide is not legal advice.

### 2. Your own signing key

Testnet keys in this repo are throwaway on purpose. Beyond testnet you need:

- your own Stellar account for the corridor's bridge asset, with its own
  trustline and funding;
- the secret seed held in a KMS/HSM, behind the `ExternalSigner` port — see
  [key management](./key-management.md). `VaultTransitSigner`, `AwsKmsSigner`
  and `GcpKmsSigner` all ship in `@corridor/stellar`;
- **never** a seed in source, in a `.env` file, in a container image, in CI logs,
  or anywhere the browser bundle can reach. The send app never holds the key:
  only the service does.

| Environment     | Signer                                | Where the seed lives                   |
| --------------- | ------------------------------------- | -------------------------------------- |
| Local / testnet | `LocalKeypairSigner` / `signerSecret` | In process — throwaway keys only       |
| **Production**  | A KMS/HSM-backed `ExternalSigner`     | In the vault; never in the app or repo |

## 1. Fork and run it

```bash
git clone https://github.com/<you>/<your-fork>.git
cd <your-fork>/web
pnpm install --ignore-workspace   # web/ is its own pnpm workspace root
pnpm dev                          # http://localhost:3000/payments
```

`web/` keeps its own lockfile and workspace (see `web/README.md`), so it builds
and runs without installing the monorepo. With no environment variables set,
`POST /api/payments` runs the **real engine** against in-memory mock anchor and
settlement adapters (`web/app/api/payments/route.ts` → `web/lib/engine-demo.ts`).
It exercises the state machine, idempotent replay and the failure scenarios, and
touches neither the Stellar network nor any anchor.

Checks, from `web/`:

```bash
pnpm lint        # oxlint
pnpm typecheck
pnpm build
```

## 2. Rebrand checklist

| File                                  | What to change                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/app/layout.tsx`                  | `metadata.title` / `description`, the font, `lang`                                                                                                  |
| `web/components/layout/Navbar.tsx`    | product name, icon, nav labels, the GitHub link (currently a `https://github.com` placeholder)                                                      |
| `web/components/layout/Footer.tsx`    | product name and licence line — keep the Apache-2.0 attribution                                                                                     |
| `web/app/globals.css`                 | colour tokens and theme (Tailwind v4 `@theme`)                                                                                                      |
| `web/components/ui/*`                 | `Button`, `Badge`, `Card`, `LivenessBadge` styling                                                                                                  |
| `web/app/payments/page.tsx`           | heading and copy — the current text says plainly that this is a simulation; keep an equally honest statement of what your app does                  |
| `web/app/page.tsx`, `app/corridors/*` | dashboard copy and the corridor detail page                                                                                                         |
| `web/app/docs/*`, `web/lib/docs.ts`   | replace the bundled docs with yours, or delete the section and its nav entry                                                                        |
| `web/next.config.ts`                  | keep the CSP and header set unless you have a concrete reason to change it; `connect-src 'self'` is why the browser never calls the engine directly |

The corridor list is **generated, not hand-edited**: `web/lib/generated/corridors.json`
and `states.json` come from `corridors/*.corridor.yaml` and
`packages/engine/src/state.ts` via `pnpm gen:web-data` (run from the repo root),
and CI fails when the committed copy drifts. Rebrand lanes by editing manifests,
not the JSON — and keep the liveness labels honest. `VERIFIED` and `PROVEN` mean
what [the README says they mean](../README.md#liveness-has-four-states-and-green-has-to-be-earned);
a lane you have not checked belongs at `UNVERIFIED`.

Keep `LICENSE` and add a `NOTICE` describing what you changed. Apache-2.0 does
not require you to use the same name or branding, and does not let you imply the
maintainers endorse your service.

## 3. Point it at a real `@corridor/service`

The app talks to exactly one endpoint, `POST /api/payments`, and that route has
two modes.

```bash
# web/.env.local — server-side only, never NEXT_PUBLIC_*
CORRIDOR_SERVICE_URL=http://localhost:8080
CORRIDOR_WEB_API_KEY=<a key your own front end must present>
CORRIDOR_SERVICE_API_KEY=<the service's Bearer key, if it requires one>
```

- `CORRIDOR_SERVICE_URL` set → the route proxies to the real service and relays
  its response, dropping the demo-only `scenario` field.
- `CORRIDOR_WEB_API_KEY` is **required** in that mode. The route fails closed
  with `503` when it is missing and `401` unless the caller presents
  `Authorization: Bearer <that key>`. That gate exists because the route
  otherwise lends the server's service credentials to any anonymous caller.
- `CORRIDOR_SERVICE_API_KEY` is attached server-side to the outbound request. It
  must never reach the browser.

Start the service from the repo root (testnet signer required):

```bash
CORRIDOR_SIGNER_SECRET=S... pnpm serve   # listens on :8080 by default
```

Two things the demo does not do, and you must, before real users touch it:

- **Authenticate the person.** `CORRIDOR_WEB_API_KEY` is a deployment gate, not
  a login. Customer identity, session handling and per-customer authorisation
  are yours to add, and the payment body must be derived from that session —
  never from an id the browser can choose.
- **Rate-limit and size-cap at the edge.** The route caps bodies at 16 KiB and
  the service has its own limiter, but a public page needs an edge limit and
  abuse monitoring too.

## 4. From testnet to real money: the gate list

Do not flip a lane to `network: public` until every line is true.

- [ ] You hold the licence(s) you need in every jurisdiction you serve, and
      counsel has signed off on the flow.
- [ ] You have an agreement with a live receiving anchor (SEP-31 needs a real
      counterparty; the repo ships no relationship and no credentials).
- [ ] The signing key is in KMS/HSM, and the seed has never existed in the app,
      the repo or CI.
- [ ] KYC/AML, sanctions screening, refunds and complaints handling are yours,
      implemented and documented.
- [ ] Operations are covered: metrics, alerting, the on-call runbook
      ([`docs/operations.md`](./operations.md)), and a durable idempotency store
      (`PostgresIdempotencyStore`, not the in-memory one).
- [ ] Your manifest is `VERIFIED` against the anchor's published `stellar.toml`
      on a recorded date, then `PROVEN` by a canary payment whose proof was
      written by `corridor canary … --write` — never hand-typed.
- [ ] You set `CORRIDOR_ALLOW_MAINNET=1` deliberately, knowing it is the only
      thing between a misconfigured manifest and a real transfer.

## 5. Keep the safety properties

A rebrand should change names, colours and copy — not the parts that keep the
flow honest. If you rewrite instead of fork, you are re-implementing:
the mandatory pre-settle gate (balance, quote window, destination, amount,
receiver status), idempotency keys with a durable store, the single-writer state
machine with no re-entry to `settling`, fail-closed error mapping, the
same-origin proxy with its API-key gate, and the response headers in
`web/next.config.ts`.

## 6. Licence

Apache-2.0 — see [LICENSE](../LICENSE). Forks may be proprietary; keep the
licence and attribution notices, and say what you changed.
