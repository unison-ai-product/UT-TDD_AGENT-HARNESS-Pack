---
schema_version: skill.v1
name: documentation-and-adrs
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L4
    - L5
    - L6
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
    - Discovery
---

# documentation and adrs

Writing a V-model design doc or ADR that survives freeze and cross-agent review.
Apply when authoring/updating any `docs/design/` doc or `docs/adr/ADR-NNN-*.md`,
or when a freeze gate needs a readability check.

## When to load this skill

- Creating or updating a design doc at any design layer (L1–L6).
- Authoring or revising an ADR.
- A pair-freeze or trace-freeze gate is about to be crossed.
- A Reverse R2–R4 pass back-fills a design doc from implementation.

## Structural baseline (before pair-freeze)

Every UT-TDD design doc needs: **Objective/TL;DR** (2–3 sentences: what changes,
why, which layer), **Scope / Non-goals**, **Prerequisites** (upstream layer docs,
PLAN/ADR IDs), **main content** at V-model granularity (designed at the level a
unit test can be written against it), **verification / acceptance criteria**, and
**terminology** (new terms added to the L0 glossary). ADRs additionally need
Context, Decision, Consequences, and Status.

## Writing rules

- One claim per sentence; name the actor (active voice). Gate conditions are
  executable contracts — "CI must be green and `ut-tdd doctor` must exit 0
  before pair-freeze" beats "the freeze passes when tests are green".
- Uniform terminology: match the spelling `ut-tdd doctor` / `rule-drift` checks;
  synonym drift causes adapter rule-drift failures.
- No bare pronouns ("this", "it") without an explicit referent — a freeze-review
  failure.

## Freeze readability check (pre-pair-freeze)

1. Scan for half-width kana (U+FF61–FF9F) and U+FFFD — these mark a
   mojibake-corrupted save; do not freeze a corrupted doc.
2. Objective/TL;DR present and ≤ 5 sentences.
3. Every introduced term matches the L0 glossary spelling.
4. Scope and Non-goals present; no bare `TODO` without a PLAN cross-reference.
5. Run `ut-tdd plan lint` for schema-level issues and `ut-tdd review
   --uncommitted` for review findings before peer review.

## ADR procedure

1. Copy the closest existing ADR as a structural template.
2. Fill Context first — the observed facts forcing the decision (cite Discovery
   PLAN / Scrum S2 PoC evidence in `.ut-tdd/`).
3. State the Decision in one active-voice sentence.
4. List Consequences: positive, negative, risks-to-monitor.
5. Set Status `Proposed`; move to `Accepted` only after `ut-tdd review
   --uncommitted` is clean and `ut-tdd doctor` exits 0. ADRs are referenced by
   PLAN `dependencies`; a missing/mis-titled ADR fails governance lint.

## Reverse back-fill (R2–R4)

R2 describes as-is architecture from the code as observed (not aspirational); R3
maps modules back to L3 functional requirements; R4 writes the L1/L3 requirement
update as if Forward had authored it (scope + acceptance + verification). A
back-filled doc passes the same readability check before trace-freeze.

## Self-edit checklist before any freeze

- [ ] Objective/TL;DR ≤ 5 sentences; Scope and Non-goals filled.
- [ ] No passive-voice gate conditions; no bare pronouns.
- [ ] Terms match / extend the L0 glossary.
- [ ] No mojibake markers (half-width kana, U+FFFD).
- [ ] ADR Status set.
- [ ] `ut-tdd plan lint` and `ut-tdd doctor` exit 0.
