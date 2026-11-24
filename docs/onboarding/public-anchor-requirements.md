# Public Onboarding Requirements: Cowrie, Zeam, and MyKobo

This note records what public sources say about onboarding a sending partner with three
receiving anchors: **Cowrie**, **Zeam** and **MyKobo**.

Scope rule (#641): every claim below links its source, either this repository's probe
records or a public page. Where none of these sources covers a partner KYB checklist,
field schema or onboarding step, that is stated as a gap rather than inferred.

---

## Summary Comparison

| Anchor              | Home Domain       | SEPs confirmed by this repo's probes                       | Partner KYB checklist or schema found? | Source                                                                                                                   |
| ------------------- | ----------------- | ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Cowrie Exchange** | `cowrie.exchange` | SEP-1, SEP-10, SEP-12, SEP-31 (no SEP-38)                  | No                                     | [`corridors/ng-cowrie.corridor.yaml`](../../corridors/ng-cowrie.corridor.yaml)                                           |
| **Zeam**            | `mint.zeam.money` | SEP-1, SEP-10, SEP-12, SEP-31, SEP-38                      | No                                     | [`corridors/zeam.corridor.yaml`](../../corridors/zeam.corridor.yaml)                                                     |
| **MyKobo**          | `mykobo.co`       | None: the advertised API host did not resolve (2026-10-16) | No                                     | [`contracts/anchors.json`](../../contracts/anchors.json), [Anchor Directory](https://anchors.stellar.org/?search=MyKobo) |

---

## 1. Cowrie (`cowrie.exchange`)

### Sourced facts

- **Protocol surface** (copied from its published
  [`stellar.toml`](https://cowrie.exchange/.well-known/stellar.toml) and probed 2026-10-17,
  recorded in [`corridors/ng-cowrie.corridor.yaml`](../../corridors/ng-cowrie.corridor.yaml)):
  - SEP-31 `DIRECT_PAYMENT_SERVER`: `https://api.cowrie.exchange/sep31/direct`. `/info`
    returned a non-empty receive list (`NGNT`, `USDC`).
  - SEP-10 `WEB_AUTH_ENDPOINT`: `https://api.cowrie.exchange/web_auth`. A challenge was signed
    and a JWT issued.
  - SEP-12 `KYC_SERVER`: `https://api.cowrie.exchange/kyc`.
  - No `ANCHOR_QUOTE_SERVER` (SEP-38) is published, so the corridor uses
    `fx.quote_source: external`.
- **Public API reference:** the [`cowriesys/stellarator`](https://github.com/cowriesys/stellarator)
  README describes a SEP-6 deposit/withdraw API with SEP-10 authentication. Each request carries
  a `customer_id` onboarded via SEP-12, and a withdrawal's `dest` is a 10-digit NUBAN account
  number.

### Gaps

None of the sources above publishes a sending-partner application form, a corporate
document checklist, a list of required licences, or a self-serve KYB portal. The corridor
file also notes that no payment should be attempted without a KYC'd business relationship
with Cowrie.

---

## 2. Zeam (`mint.zeam.money`)

### Sourced facts

- **Home domain:** `mint.zeam.money`, the `toml_file` the
  [Stellar Anchor Directory](https://anchors.stellar.org/) lists for its "Zeam" entry
  ([`stellar.toml`](https://mint.zeam.money/.well-known/stellar.toml)). The directory entry lists
  the Democratic Republic of the Congo, Malawi, South Africa, Zambia and Zimbabwe
  ([`contracts/anchors.json`](../../contracts/anchors.json)).
- **Protocol surface** (probed 2026-10-17, recorded in
  [`corridors/zeam.corridor.yaml`](../../corridors/zeam.corridor.yaml)):
  - SEP-31 `DIRECT_PAYMENT_SERVER`: `https://anchor.zeam.money/sep31`. `/info` declared
    `quotes_supported: true` for `USDC`, with `min_amount: "1"` and `max_amount: "10000"`.
  - SEP-10 `WEB_AUTH_ENDPOINT`: `https://anchor.zeam.money/auth`.
  - SEP-12 `KYC_SERVER`: `https://anchor.zeam.money/customer`, with SEP-12 customer types
    `sep31-sender` and `sep31-receiver`.
  - SEP-38 `ANCHOR_QUOTE_SERVER`: `https://anchor.zeam.money/sep38`. A firm quote came back
    with a future expiry.
- **Anchored assets:** its `stellar.toml` anchors `ZARZ` (anchor asset ZAR, South African
  Reserve Bank TPP `SO001233`) and `GBPZ`, as recorded in the corridor file.

### Gaps

None of the sources above publishes required KYB field names, a per-country corporate
document list, approval timelines, or sandbox self-registration. The SEP-12 customer types
are the only partner-facing schema hint, and their field requirements are only visible
through a live, authenticated `GET /customer`.

---

## 3. MyKobo (`mykobo.co`)

### Sourced facts

- Listed in the [Stellar Anchor Directory](https://anchors.stellar.org/?search=MyKobo). Its
  `stellar.toml` advertises SEP-6, SEP-24 and SEP-31.
- Probed 2026-10-16 ([`contracts/anchors.json`](../../contracts/anchors.json), `$comment`): the
  host it publishes for those APIs, `stellar.mykobo.co`, did not resolve, so the SEP-10 and
  SEP-31 probes failed, and MyKobo's status page listed the Anchor service as down at the time.
  No live SEP-12 or SEP-31 `/info` fields could be read, and no corridor manifest was written.

### Gaps

Because the anchor's APIs were unreachable, this repository has no protocol-level record of
MyKobo's customer or partner requirements. Re-probe with `pnpm probe:anchor mykobo.co` before
relying on anything here.

---

## Implications for Corridor Exporters

None of these anchors publishes a machine-readable partner KYB schema in the sources above,
so an exporter cannot be built against anchor-specific partner fields today:

1. Exporters should start with targets this project controls, such as the local reference
   anchor in `scripts/reference-anchor.sh`, or with live SEP-12 `GET /customer` responses where
   an anchor exposes them.
2. Until an anchor publishes its fields, the business's details live in the v0 company
   profile ([`schemas/company-profile.v0.schema.json`](../../schemas/company-profile.v0.schema.json),
   added in #637). An exporter maps from that profile once a target's real fields are known,
   instead of guessing at them.
