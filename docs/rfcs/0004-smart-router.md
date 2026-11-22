# RFC 0004: Smart router, reusable onboarding and the road to mainnet

- Status: proposed
- Builds on: [RFC 0001](0001-protocol-agnostic-corridors.md) (protocol-agnostic corridors), [RFC 0002](0002-source-side-funding.md) (source-side funding), [RFC 0003](0003-sep24-interactive-handoff.md) (SEP-24 handoff)
- Related: [docs/route-resolver.md](../route-resolver.md), [docs/mainnet-registry.md](../mainnet-registry.md), [#223](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/223)

## Summary

Today the caller picks the route. `PaymentIntent.corridorId`
(`packages/types/src/index.ts`) names one corridor, and the `RouteResolver`
only confirms the single receiving anchor that corridor declares
(`packages/router/src/index.ts`). The registry already knows which anchors
are live and what they serve, but nothing uses that knowledge to _choose_.

This RFC adds a **route planner**. It takes "send this amount to this country
and currency" and returns ranked route options, each one with an honest price
label. It also sets the rules for three things the planner depends on: rate
history, onboarding between sending and receiving anchors, and the order of
steps to mainnet.

Nothing here changes who holds money. The project stays non-custodial.

## Roles and custody (fixed, not up for change in this RFC)

```
Sender ──fiat──▶ SENDING ANCHOR ──USDC on Stellar──▶ RECEIVING ANCHOR ──fiat──▶ Recipient
                 holds funds until                  holds funds until
                 it settles                         it pays out
```

- **Sending anchor**: the licensed business that runs corridor-in-a-box
  (`@corridor/service`, or the packages as a library) on its own
  infrastructure, signing with its own key. It collects KYC on the sender,
  collects the recipient's payout details from the sender, and passes both to
  the receiving anchor through SEP-12 (`sep31-sender`, `sep31-receiver`).
- **Receiving anchor**: runs its own SEP-31 server. It installs nothing from
  this project.
- **The Stellar payment**: one atomic payment. No party holds funds in transit.
- **This project**: publishes the software and runs public, read-only
  services: the registry, the attester, the probes, the dashboard and the rate
  history. It never holds funds, never holds a customer's key, never signs a
  payment and never stores customer KYC data.

Any design that has the project receive funds and forward them, keep a float,
or guarantee a price with its own money is out of scope. That model needs
money-transmission licences in every sending jurisdiction and is not what this
project is.

## Decisions

| #   | Decision                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The planner only decides. The sending business's own signer executes.                                                                    |
| D2  | Every price carries one of three labels: `locked`, `indicative`, `estimated`.                                                            |
| D3  | `estimated` uses the lower quartile (P25) of the last 7 days of rates, minus a 0.5% margin. Window and margin are per-business settings. |
| D4  | Whether an estimated price is guaranteed is the sending business's setting, off by default, and the business carries the gap.            |
| D5  | Route types ship in order: SEP-31 now; SEP-6 with an explicit third-party-payout flag next; "recipient cashes out" later.                |
| D6  | Rate history collection starts now, before the planner ships.                                                                            |
| D7  | Reusable onboarding (a company profile plus lane checks) is a product feature.                                                           |
| D8  | A testnet reference send app is built on top of `@corridor/service`.                                                                     |
| D9  | Mainnet order: contracts, then read-only probes and dashboard, then rate history, then a pilot with a licensed partner.                  |
| D10 | Reusable end-user KYC and an AI rate model are parked (see "Not in scope").                                                              |

## 1. The route planner

### Where it sits

The planner runs **before** `execute()`, not inside it. It replaces the caller
picking `corridorId` by hand. The existing `RouteResolver` seam stays and gets
a simpler job: return the anchor the planner already chose.

```
RouteRequest ──▶ RoutePlanner.plan() ──▶ RouteOption[] (ranked)
                                              │ caller or policy picks one
                                              ▼
                       PaymentIntent{corridorId, pinned route} ──▶ execute()
                                              │
                         PinnedRouteResolver.resolve() returns the pinned anchor
```

Pinning matters. `docs/route-resolver.md` warns that `resolve()` runs again on
resume, and that a resolver whose choice drifts can make reconciliation poll
the wrong anchor. If the decision is stored with the run, a resume always goes
back to the anchor the money was sent to.

### Interface sketch

```ts
interface RouteRequest {
  readonly sourceAmount: Money; // e.g. 100 USDC
  readonly destAsset: string; // e.g. "iso4217:NGN"
  readonly destCountry: string; // ISO 3166-1 alpha-2
  readonly payoutMethod?: string; // "bank_account", "mobile_money", ...
  readonly policy?: RoutePolicy;
}

interface RoutePolicy {
  readonly allowedLabels?: ReadonlyArray<PriceLabel>; // e.g. ["locked"] for locked-only
  readonly guaranteeEstimates?: boolean; // D4, default false
  readonly estimateWindowDays?: number; // D3, default 7
  readonly estimateMarginBps?: number; // D3, default 50
}

type PriceLabel = "locked" | "indicative" | "estimated";

interface RouteOption {
  readonly corridorId: string;
  readonly receivingDomain: string;
  readonly protocol: "sep31" | "sep6" | "wallet";
  readonly price: {
    readonly label: PriceLabel;
    readonly rate: string; // dest units per 1 source unit
    readonly quoteId?: string; // locked only
    readonly expiresAt?: number; // locked only
    readonly basis?: string; // estimated: "P25 of 1,912 samples, 7d"
  };
  readonly recipientGets: Money; // after fees, at the labelled rate
  readonly fees: Money;
  readonly reliability: number; // 0..1, see "Ranking"
  readonly reasons: ReadonlyArray<string>; // why it ranked here, for display and audit
}

interface RoutePlanner {
  plan(req: RouteRequest): Promise<ReadonlyArray<RouteOption>>;
}
```

### Steps inside `plan()`

1. **Candidates.** Read the corridors the business has configured whose
   destination matches `destAsset` and `destCountry`.
2. **Evidence.** Keep only anchors with a fresh registry attestation for the
   corridor's protocol. This is the same check `RegistryRouteResolver` makes
   today, with the same rule: unknown is refused, never assumed.
3. **Lane check.** Keep only anchors that have onboarded _this_ sending
   business (section 4).
4. **Limits.** Drop anchors whose `min_amount`/`max_amount` excludes the
   amount, or whose required fields the request cannot supply.
5. **Health.** Drop anchors whose engine circuit breaker is open.
6. **Price.** Ask each remaining anchor for a price. A SEP-38 firm quote is
   `locked`. SEP-38 `/price`, or a rate the anchor publishes, is `indicative`.
   No price at all falls back to `estimated` from history (section 3). An
   anchor with no price and not enough history is returned as unpriceable and
   ranked last.
7. **Rank** and return every option, including the dropped ones with their
   reason, so a business can see why a route was not offered.

### Ranking

Rank by **what the recipient gets, priced cautiously**, then by reliability:

- `locked`: the quoted amount.
- `indicative`: the indicative amount minus the estimate margin, because it is
  not promised.
- `estimated`: the P25 amount minus the margin (D3).

Reliability = this business's own success rate on that anchor over the last
30 days, scaled down when the attestation is old. Ties go to the faster
anchor. The ranking is deterministic and every option carries `reasons`, so a
choice can always be explained. No hidden weights.

### Fallback

- **Before funds move** (quote refused, KYC rejected, `openTransaction`
  failed): the run is marked failed, and a new run starts on the next option
  with a derived idempotency key (`<key>:alt1`). The audit trail links the two.
- **After `settle` starts**: never switch. Recovery follows the existing
  refund path.

### Engine changes this needs

- Accept a **pre-fetched quote** so a `locked` option is honoured instead of
  re-quoted inside `execute()`. If the quote has expired, refuse; don't
  silently re-quote at a different price.
- Persist the pinned route with the run, and add `PinnedRouteResolver`.
- Update `docs/route-resolver.md`. Its "Known gap" section is out of date:
  `resolveRoute()` in `packages/engine/src/run.ts` already turns a throw from
  `resolve()` into a `ROUTE_REFUSED` failure (#257, closed).

## 2. Price labels shown to people

| Label        | Shown to the sender as                                                    | Meaning                                   |
| ------------ | ------------------------------------------------------------------------- | ----------------------------------------- |
| `locked`     | "Recipient gets ₦X. Locked for 60 s."                                     | A firm SEP-38 quote.                      |
| `indicative` | "About ₦X. Final amount set at payout."                                   | The anchor's current price, not promised. |
| `estimated`  | "At least ₦X (estimated)" if guaranteed, otherwise "About ₦X (estimated)" | From our rate history (section 3).        |

Labels are never mixed or rounded into each other. In many jurisdictions
remittance rules require an estimate to be disclosed as an estimate. The
business's legal team decides which labels it can show; `policy.allowedLabels`
enforces that.

When a business turns on `guaranteeEstimates`, it pays out the shown amount
and absorbs any difference from its own funds. The engine records the
difference per payment (`estimate_gap`) so the business can see what the
guarantee costs it.

## 3. Rate history

Without it, `estimated` cannot exist and the parked AI model has nothing to
learn from, so collection starts before the planner ships (D6).

- **Collected every 15 minutes:**
  - each attested anchor's SEP-38 indicative price, for each pair it lists
  - Stellar DEX trade prices for the same pairs
  - a public reference FX rate. The source is still to be chosen and must have
    a licence that allows republishing.
- **From the business's own completed payments:** the effective rate
  (`amount_out / amount_in`). This is the only data available for anchors
  that publish no price.
- **Storage:** a small Postgres database fed by an always-on collector, not
  the chain. The collector is read-only public data, so running it keeps the
  project non-custodial. GitHub Actions schedules are too unreliable at
  15-minute intervals.
- **Published:** a daily summary per pair (min, P25, median, P75, max, sample
  count) as JSON, so anyone can check the numbers the router uses.
- **Minimum data:** an anchor gets `estimated` only with at least 7 days of
  data and at least 100 samples in the window. Below that it is unpriceable.

## 4. Reusable onboarding

A receiving anchor only accepts a sending anchor it has onboarded: company
checks (KYB), a contract, then an allowlisted Stellar account. Today this is
done by email and PDF, separately for each pair. This is the main thing that
limits how many routes a business can use.

### 4a. Company profile (no receiver involvement needed)

- A versioned JSON schema for the sending business's onboarding pack:
  - legal entity, licences per jurisdiction
  - ownership and directors
  - AML/CFT policy summary
  - Stellar accounts
  - contacts
- Filled once by the business. The documents themselves stay in the
  business's own storage; the profile references them.
- Exporters map the profile onto each receiving anchor's known onboarding
  form, so the business never re-types it.
- **Receiver opt-in** means a receiving anchor agrees to accept the standard
  profile directly instead of its own form. Until it does, the exporter is the
  path.

### 4b. Lane check (which receivers accept this sender)

The planner needs to know, per sending business, which receivers will accept
it (step 3 above).

- **v1, private, needs nothing from receivers:** the sending business's
  service checks each receiver with its own key. If SEP-10 auth succeeds and a
  test `GET /sep31/info` is authorised, the lane is open. Lanes are cached and
  re-checked daily, and the business can also mark lanes open by hand. The
  result stays inside the business's deployment.
- **Later, public, receiver opt-in:** a receiver signs an on-chain record,
  "sender account G… is accepted for asset X". This is opt-in for a reason:
  public lane records reveal who partners with whom, and many businesses treat
  that as confidential.

Some receivers allowlist at `POST /transactions` rather than at SEP-10, so a
passing v1 check is "probably open", not "confirmed". The first real payment
confirms it. The planner shows the difference.

## 5. Route types

| Type     | Status | How the money moves                                                                                                   | Gate                                                                                                                 |
| -------- | ------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sep31`  | now    | anchor-to-anchor, receiver pays the recipient                                                                         | attested + lane open                                                                                                 |
| `sep6`   | next   | the business withdraws via SEP-6 to the recipient's account                                                           | the manifest must declare `third_party_payout: true`, confirmed with the anchor; this cannot be probed automatically |
| `wallet` | later  | plain USDC payment to the recipient's own Stellar wallet; the recipient cashes out through a SEP-24 anchor themselves | the recipient has a wallet; the engine never drives SEP-24 (RFC 0003)                                                |

## 6. Testnet reference send app

- A small web app on top of `@corridor/service`. The sender:
  - enters an amount and a destination
  - sees the ranked options with their labels
  - picks one, sends testnet funds
  - follows the payment to `completed`
- The sending account is our testnet account. Receivers are the self-hosted
  reference anchor and `testanchor.stellar.org`.
- Every screen says it is testnet with no real money.
- The service needs an always-on host (it watches payments). It shares that
  host with the rate collector.
- It doubles as a starter that a business can fork and rebrand. On mainnet it
  only ever runs under a licensed business's name and key.

## 7. Mainnet order

1. Deploy the registry and attester to mainnet (`docs/mainnet-registry.md`).
2. Run the read-only probes against mainnet anchors and show them on the
   dashboard.
3. Collect rate history from mainnet indicative prices.
4. Pilot real payments, small amounts, only through a licensed partner acting
   as the sending anchor.

Steps 1 to 3 move no money and need no licence. Step 4 is gated on a partner,
not on code.

## Not in scope

- **The project holding or forwarding funds.** Rejected (see "Roles and
  custody").
- **Split routing** (`RouteDecision.split`). Still reserved; one route per
  payment.
- **Reusable end-user KYC.** Parked. If it returns, the shape is a credential
  the user holds, signed by the business that performed the check, with the
  project storing no identity documents.
- **AI rate model.** Parked until rate history has months of data. It would
  replace the fixed P25 rule in D3, not the labels.

## Open questions

1. Reference FX source with a licence that allows republishing.
2. Where the always-on host runs (Fly, Render or a VPS) and who pays for it.
3. Whether `reliability` should count failures caused by the business's own
   data (for example, rejected recipient details) against the anchor.
4. Schema owner for the company profile: this repo, or a SEP proposal once
   two or more receivers accept it.

## Follow-up work (to be opened as issues)

1. Rate collector and daily summary (D6), first.
2. `RoutePlanner` with SEP-31 candidates, ranking and `reasons`.
3. Engine: pre-fetched quote, pinned route, `resolve()` failure moves the run
   to `failed`.
4. Lane check v1.
5. Company profile schema and the first exporter.
6. Testnet reference send app.
7. Manifest `third_party_payout` flag and SEP-6 candidates.
8. Mainnet registry deploy and mainnet probes.
