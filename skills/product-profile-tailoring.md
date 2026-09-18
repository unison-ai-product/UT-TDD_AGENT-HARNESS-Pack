---
schema_version: skill.v1
name: product-profile-tailoring
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
  drive_models:
    - Forward
    - Add-feature
    - Discovery
decision_points:
  - when: "A project's design-doc scope has not been decided yet and both a delivery scale and a client platform are known."
    choose: "apply two independent profile presets — one scale preset (PoC / Standard / Enterprise) and one platform preset (Web / Mobile / Desktop / CLI / API-service) — and merge their adoption/granularity results per document"
    over: "picking a single combined profile name or guessing scope doc-by-doc from scratch"
    because: "scale and platform are orthogonal axes in the source catalog: scale sets how much default work is in scope and how deep the core docs go, while platform sets which client-layer doc set is even relevant; collapsing them into one guess loses the axis that actually drives the adopt/na split for client-specific docs."
  - when: "Applying the PoC scale preset to a project."
    choose: "default every catalog document to `na` (out of scope) except the ~19 documents the PoC preset explicitly adopts (tailoring, PoC-verification, charter, demand, requirements, use-case list, screen requirements, system config, function list, screen list, domain, DB, security, test plan, UI test, measurement, AI-verification, and the four core diagrams), and keep PoC-verification plus AI-verification at their preset strength (詳細/standard) rather than thinning them along with everything else"
    over: "adopting the full standard catalog at reduced detail, or thinning PoC-verification/AI-verification down to `簡易`/light along with the rest"
    because: "the preset's own default_status is na and default_detail is light — a PoC is defined by *not* building most of the standard doc set, not by building a thin version of all of it; PoC-verification and AI-verification are the two docs the PoC exists to produce evidence for, so the preset keeps them strong even while everything else is minimal or absent."
  - when: "Applying the Enterprise scale preset to a project."
    choose: "default every catalog document to `done` (adopted) and force detailed (詳細) granularity specifically on security, privacy, appsec, DR/BCP, verification, AI-verification, logging, ops, network, server, integration, and maintenance — even where the platform preset or a manual decision would otherwise leave them at standard"
    over: "adopting everything at Standard-level detail and treating Enterprise as 'Standard plus more documents'"
    because: "the preset's detail_override list is the concrete, load-bearing difference between Standard and Enterprise — Enterprise is not just broader adoption, it is a forced floor on exactly the audit-facing and operability-facing categories that Standard leaves at the project's own judgement, per [[design-tailoring-and-granularity]]'s Enterprise row."
  - when: "Applying a platform preset (e.g. Web) to a project."
    choose: "adopt that platform's client-layer docs (for Web: fe_design, browser_responsive, web_perf, web_session at their preset strengths) and leave the other platforms' client-specific docs (mobile_arch, offline_sync, desk_arch, desk_sign, cli_arch, api_gov, etc.) at the preset's default_status of `na`"
    over: "adopting every platform's client-layer doc set defensively in case the product later expands to another platform"
    because: "each platform preset's adopt map only lists its own client-layer keys (Web adds fe_design/browser_responsive/web_perf/web_session; Mobile adds mobile_arch/offline_sync/push_perms/app_dist/mobile_sec/device_compat; Desktop adds desk_arch/desk_pkg/desk_update/desk_sign/desk_os/desk_sec; CLI adds cli_arch/cli_cfg/cli_dist; APIService adds api_gov/api_portal/api_webhook) — a doc for a client layer the product does not have is structurally absent per [[design-tailoring-and-granularity]]'s na test, and pre-adopting it anticipates a decision that has not been made yet."
  - when: "A scale or platform preset sets a document's adoption or granularity, and the project's actual situation differs from what the preset assumes (e.g. a Standard-scale project has one genuinely regulated document, or a Web project needs one CLI doc for an internal admin tool)."
    choose: "apply the preset first, then individually adjust the specific document, and record the adjustment and its reason (e.g. in the tailoring doc's own note or the PLAN decision log)"
    over: "either accepting every preset value unmodified, or hand-picking every document's status/detail from zero without applying a preset at all"
    because: "the preset is declared as a starting point the project 'individually adjusts' from, not a final answer; skipping the preset step re-derives judgement calls the profile already encodes, while accepting it unmodified ignores real per-project variance the preset cannot see — the adjustment-plus-reason is what keeps the deviation auditable instead of silent."
  - when: "A scale or platform preset would set a structurally-present concern to `na` (e.g. a PoC preset defaulting a security doc that the PoC actually handles PII to na, or a platform preset defaulting away a doc the product genuinely needs)."
    choose: "override the preset to `todo`/adopted for that specific document and record why the preset default did not apply"
    over: "letting the preset's na default stand because 'that's what the profile says'"
    because: "[[design-tailoring-and-granularity]]'s na-prohibition is unconditional: na is only valid when a concern is structurally absent, and a profile preset is a convenience default, not a license to na away a concern that structurally exists — the preset can be wrong for this specific project and the prohibition still binds."
  - when: "Two profiles are being combined (e.g. Standard scale + Mobile platform) and they disagree on a document's status or granularity for the same key (e.g. the scale preset implies a lighter core-doc bar than the platform preset's adopt map states)."
    choose: "take the more specific/more demanding of the two per document — a platform preset's explicit per-doc entry (adopt map + detail) overrides a scale preset's blanket default_status, and an Enterprise detail_override always wins over a platform preset's plain adopt-map detail for the same key"
    over: "letting whichever profile was applied last silently overwrite the other, or averaging the two"
    because: "the presets are declared as independent axes meant to be merged, not alternatives; blanket defaults exist to be overridden by more specific entries (this is the same specificity-wins pattern the catalog uses between default_status and an explicit adopt/detail_override key), and silently picking 'whichever ran last' makes the merged result depend on execution order instead of on the documents' actual scope."
  - when: "A document's granularity needs to be set or reviewed, independent of which profile preset produced the current value."
    choose: "classify it against the four defined granularity bands (省略/na = not written this project; 簡易/light = policy + list only, no per-item detail, ~<=12 table rows; 標準/standard = list + per-item detail an implementer can act on, ~12-27 rows; 詳細/detailed = full per-item detail including boundary/error cases, third-party-auditable, ~28+ rows) rather than a vague 'more or less detail' judgement"
    over: "deciding granularity by gut feel about how important the document 'seems'"
    because: "the source tailoring design defines granularity by what the reader can *do* with the document (grasp direction / act on it / audit or implement from it independently) plus a concrete row-count band, and explicitly warns that declaring everything detailed is 'granularity inflation' that drifts from the actual content — a vague judgement reproduces exactly that drift."
---

# product profile tailoring

Given a delivery scale and a client platform, this skill is the
machine-usable preset lookup for *which* documents a project adopts and at
*what* granularity by default — the pattern-conditional companion to
[[design-tailoring-and-granularity]], which owns the general per-document
na/todo judgement and the map of where each kind of decision gets recorded.

## When to load this skill

- Starting a new project or Add-feature slice and the delivery scale (PoC /
  Standard / Enterprise) and/or client platform (Web / Mobile / Desktop / CLI
  / API-service) are known or need to be decided.
- Someone asks "what does a PoC skip that Standard includes?" or "what changes
  if this becomes Enterprise?" or "which docs does a CLI tool not need that a
  Web app does?"
- A coverage/tailoring report shows a document's status or granularity and it
  is unclear whether that value came from a profile preset, a manual
  adjustment, or an unresolved default.
- Reviewing whether a preset's `na` default is masking a structurally-present
  concern for this specific project.

## The two-axis profile model

Every project profile is the merge of two independent axes:

1. **Scale** — PoC / Standard / Enterprise. Sets the *default adoption
   posture* (how much of the catalog is in scope by default) and forces
   granularity floors on specific categories.
2. **Platform** — Web / Mobile / Desktop / CLI / API-service. Sets which
   *client-layer* document set is adopted (each platform preset adopts only
   its own client-specific docs and leaves the others at `na`) and carries a
   near-identical adoption of the shared core/domain/security/ops docs across
   all five platform presets.

A project profile is the pair — e.g. "Standard + Web", "PoC + Mobile",
"Enterprise + APIService" — and both presets are applied and merged, not
chosen as alternatives.

## How a preset sets adoption and granularity as a starting point

Each preset (scale or platform) declares:

- `default_status` — the fallback adoption state (`na`, `keep`, or `done`)
  applied to any catalog document the preset does not name explicitly.
- `default_detail` — the fallback granularity applied alongside
  `default_status`.
- `adopt` — a per-document-key map of `{key: granularity}` for documents this
  preset explicitly wants in scope, overriding the blanket default for those
  keys.
- (Enterprise only) `detail_override` — a per-document-key map that forces a
  granularity floor regardless of what the adopt map or another preset would
  otherwise set.

This full preset value (status + granularity per document) is a **starting
point**, not a final answer. The project then individually adjusts specific
documents away from the preset where its actual situation differs, and
**that adjustment plus its reason is recorded** — in the tailoring doc's own
note or the PLAN decision log, per [[design-tailoring-and-granularity]]'s
Step 5 recording map. A preset value that was never reviewed is not the same
as a preset value that was reviewed and confirmed correct.

## Concrete pattern rules

### PoC

- `default_status: na`, `default_detail: 簡易` (light) — almost everything is
  out of scope by default.
- Adopts only ~19 documents: tailoring note, PoC-verification, charter
  (企画), demand (要求), requirements (要件), use-case list, screen
  requirements, system config, function list, screen list, domain model, DB,
  security, test plan, UI test, measurement, AI-verification, plus system-
  config/screen/ER diagrams.
- Of those 19, **PoC-verification is kept at 詳細 (detailed) and
  AI-verification at 標準 (standard)** — not thinned to light along with the
  rest. A PoC is defined by producing strong evidence on the spike question
  and on whether AI-generated output can be trusted, even while every other
  document is minimal or absent.
- See [[vmodel-stage-integration-acceptance-ops]] for how this preset
  replaces the full integration/system/acceptance/operational ladder with the
  PoC-verification design at execution time.

### Enterprise

- `default_status: done` — everything in the catalog is adopted by default
  (the inverse of PoC's default).
- Forces `詳細` (detailed) via `detail_override` on: security, privacy,
  appsec, DR/BCP, verification, AI-verification, logging, ops, network,
  server, integration, and maintenance — regardless of what a platform
  preset's adopt map or a manual choice would otherwise set for these keys.
  This override is the concrete difference between "Enterprise = Standard
  plus more docs" (wrong) and "Enterprise = a forced audit/operability floor
  on named categories" (correct).

### Platform presets (Web / Mobile / Desktop / CLI / APIService)

- All five share a near-identical adopt map for the core/domain/security/ops
  document set (requirements, function/screen/API lists, domain model,
  security, ops, CI/CD, event schema, agent docs, billing, tenant lifecycle,
  etc.) at consistent granularities — the platform axis is not meant to
  re-litigate the core doc set.
- Each platform preset then adds **only its own client-layer keys**:
  - Web: `fe_design` (詳細), `browser_responsive`, `web_perf`, `web_session`
    (標準).
  - Mobile: `mobile_arch`, `mobile_sec` (詳細), `offline_sync` (詳細),
    `push_perms`, `app_dist`, `device_compat` (標準).
  - Desktop: `desk_arch`, `desk_sign`, `desk_sec` (詳細), `desk_pkg`,
    `desk_update`, `desk_os` (標準).
  - CLI: `cli_arch` (詳細), `cli_cfg`, `cli_dist` (標準).
  - APIService: `api_gov`, `api_portal`, `api_webhook` (標準).
- `default_status: na` on every platform preset means a document key unique
  to a *different* platform (e.g. `mobile_sec` under a Web profile) stays
  `na` by default — the product genuinely does not have that client layer,
  which is exactly the structural-absence condition
  [[design-tailoring-and-granularity]] requires for a valid `na`.

## The na-prohibition still binds through presets

A profile preset's `default_status: na` or an unlisted key defaulting to
`na` is a **convenience default**, not evidence that the concern is
structurally absent. If a project under a PoC or a given platform preset
actually has a structurally-present concern the preset defaults away (e.g. a
PoC that already handles real user PII, or a Web product with an internal
CLI admin tool), the preset must be overridden to `todo`/adopted for that
document, with the override reason recorded. The rule from
[[design-tailoring-and-granularity]] is unconditional: **na is only valid
when the concern is structurally absent from the project — a preset saying
`na` does not change what is structurally true about this specific
project.**

## Merging two presets on the same document key

When scale and platform presets both speak to the same document key:

- A platform preset's explicit `adopt` entry (specific) overrides a scale
  preset's blanket `default_status` (general) for that key.
- An Enterprise `detail_override` always wins over a plain platform-preset
  `adopt` granularity for the same key — the override exists specifically to
  force a floor that a platform preset's ordinary entry does not carry.
- Resolve by specificity, not by which preset was applied last. If a merge is
  genuinely ambiguous (neither preset's entry is obviously more specific),
  treat it as the escalation case from [[design-tailoring-and-granularity]]'s
  final rule: present the tradeoff and let the human decide.

## The four granularity bands

Independent of which preset produced a value, granularity is judged against
four defined bands (source: tailoring design doc's own granularity table),
not a vague "more or less detail" feeling:

| Band | Definition | Row-count guide | Typical fit |
|---|---|---|---|
| 省略 (na) | Not written for this project | — | Structurally absent concern |
| 簡易 (light) | Policy + list only, no per-item detail; reader grasps direction | up to ~12 rows | Charter, index docs, directory structure, early SEO |
| 標準 (standard) | List + per-item detail an implementer can act on | ~12-27 rows | Most design docs by default |
| 詳細 (detailed) | Full per-item detail including boundary/error cases; a third party can implement or audit from it alone | ~28+ rows | Core requirements/basic/detailed design, and whatever this project's "main concern" actually is (e.g. billing + tenant design for a SaaS product) |

Two calibration rules from the source design, both still binding after a
preset is applied:

- **Detail only the project's actual main concern**, not everything. Marking
  every document detailed is granularity inflation — it does not match the
  real content and shows up as a gap between declared and actual granularity.
- **The V-model core should thicken going down the descent**, not up: L3
  requirements thinner than L4 basic design thinner than L5 detailed design
  is the healthy gradient. A requirements doc thicker than its basic design is
  a sign the requirements over-specified or the design under-specified, not a
  sign of thoroughness.

## Boundary with existing skills

- **[[design-tailoring-and-granularity]]** owns the *general* judgement:
  which documents a project needs at all (the todo/na self-questions), the
  four granularity bands' meaning, and the map of where each kind of decision
  (ADR, requirement, glossary term, risk, tailoring note) gets recorded. It
  applies to every project regardless of profile.
- **[[product-profile-tailoring]] (this skill)** owns the *pattern-preset*
  layer on top of that: given a known scale and platform, what the starting
  adoption/granularity values are before individual adjustment, and how two
  presets merge. It runs after scale/platform are known and before the
  general per-document judgement is applied to the remaining ambiguous cases.
- **[[vmodel-stage-integration-acceptance-ops]]** consumes this skill's PoC
  preset outcome (PoC-verification substituting for the full ascent ladder)
  and Enterprise's forced `verification`/`ai_verification` detail floor when
  scoping the ascent rungs for a given project.
- **[[poc]]** owns the S0-S4 process mechanics once PoC scope has been set by
  this skill's PoC preset; this skill only sets which documents and what
  granularity, not the PoC workflow itself.

## Anti-patterns

- Guessing a single combined "profile" instead of applying scale and platform
  as two independent presets and merging them.
- Thinning PoC-verification or AI-verification down to light along with the
  rest of a PoC's minimal doc set.
- Treating Enterprise as "Standard plus more adopted documents" instead of
  applying its forced detail floor on security/privacy/DR-BCP/verification/
  logging/ops/network/server/integration/maintenance.
- Pre-adopting another platform's client-layer docs "in case the product
  expands there later" instead of leaving them `na` until that expansion is
  a real decision.
- Accepting a preset's `na` default for a document that covers a concern this
  specific project structurally has (e.g. real PII in a PoC).
- Applying preset values without recording individual adjustments, or
  hand-deriving every document's status from zero without applying the
  preset as a starting point.
- Declaring a document's granularity by gut feel instead of against the four
  defined bands and their row-count guide.
