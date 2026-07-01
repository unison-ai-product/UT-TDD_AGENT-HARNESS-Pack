---
schema_version: skill.v1
name: debt-register
skill_type: process
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Retrofit
    - Recovery
---

# debt register

How to record, track, and discharge technical debt in UT-TDD (FR-L1-11
technical-debt ledger). Debt entries are PLAN records and
`.ut-tdd/`-referenced documents — NOT a `ut-tdd debt` command. Debt
visibility is surfaced by `ut-tdd doctor` through governance gate checks on
provisional decisions and missing Reverse back-fills.

## When to load this skill

- A shortcut or deferral was accepted during implementation that weakens a
  V-model layer (missing design doc, `@ts-ignore`, skipped test, `// TODO`
  without a PLAN link).
- A provisional architectural decision has exceeded its TTL (time-to-live).
- `ut-tdd doctor` surfaces a PLAN with `kind: retrofit` or `kind: refactor`
  whose `dependencies` reference an unresolved debt entry.
- A Recovery cycle needs to enumerate the accumulated debt before a
  troubleshoot PLAN is authored.

## Debt entry anatomy

A debt entry is a PLAN file with `kind: refactor` or `kind: retrofit`, or an
inline marker in an existing PLAN's `debt_items` field. Both forms must carry:

```yaml
# In a dedicated PLAN file (preferred for standalone debt):
kind: refactor          # or: retrofit
layer: L6               # layer where the debt lives
drive: Refactor
status: draft           # becomes active when work is scheduled
debt_reason: >
  L6 design doc for auth-middleware was omitted under time pressure
  (2026-06-10 pair-freeze). Reverse back-fill required.
ttl: "2026-08-01"       # provisional decision expiry; doctor flags overdue
review_evidence: []
```

```yaml
# Inline in a parent PLAN's debt_items list (lightweight, not standalone):
debt_items:
  - id: DEBT-L7-03
    description: "Unit test for projection edge case deferred (no time-box)"
    ttl: "2026-07-15"
    discharge_plan: PLAN-L7-NN
```

`ut-tdd doctor` checks that any PLAN referencing a `discharge_plan` ID
resolves to an existing file and that `ttl` has not passed without a `done`
status.

## Provisional decision TTL discipline

When a design or implementation decision is marked provisional:

1. Set `ttl` to a concrete date (not "soon" or "next sprint").
2. Record the condition that makes the decision final (e.g., "confirmed when
   FR-L1-38 telemetry data shows latency under 50 ms").
3. `ut-tdd doctor` will flag the PLAN as `overdue-provisional` once the date
   passes.
4. Overdue provisionals must either be discharged (Refactor/Retrofit PLAN
   advanced to `done`) or have their TTL extended with a recorded rationale
   in `review_evidence`.

Never silently extend a TTL — record the reason.

## Debt surfacing and discharge workflow

```
ut-tdd doctor               # surfaces overdue-provisional and unlinked debt
ut-tdd status               # shows debt-related PLANs in active/draft
ut-tdd plan lint            # validates debt PLAN frontmatter and TTL field
ut-tdd review --uncommitted # confirms substance of discharge before accept
ut-tdd vmodel lint          # checks that discharged debt restores V-model links
```

Discharge steps for a standalone debt PLAN:

```
## §工程表 (Refactor or Retrofit drive)
1. [直列] Identify V-model gap: which layer doc or test is absent/broken
2. [直列] Author or repair the missing artifact (design doc / test design)
3. [並列] Implement fix in src/ — scoped to the debt_reason
4. [並列] bun run typecheck && bun run lint && bun run test — green
5. [直列] ut-tdd doctor — no new governance failures
6. [直列] ut-tdd review --uncommitted — debt PLAN review_evidence populated
7. [直列] Set status: done; ut-tdd handover if session boundary
```

## Debt that must NOT stay implicit

The following forms of implicit debt are governance violations and will be
caught by `ut-tdd doctor` or `ut-tdd plan lint`:

- An `add-impl` PLAN with no Reverse back-fill PLAN in `dependencies`.
- A `@ts-ignore` or `// biome-ignore` comment without a PLAN-linked rationale
  in the same file (detectable by `bun run lint`).
- A design doc path listed in a PLAN `generates` field that does not exist
  on disk.
- A `trace-freeze` PLAN with `review_evidence: []`.

## Anti-patterns

- Treating a `// TODO: fix later` comment as a registered debt item — it has
  no TTL, no owner, and is invisible to `ut-tdd doctor`.
- Creating a debt PLAN but never linking it in the creditor PLAN's
  `dependencies` — the discharge is then invisible to governance.
- Setting `ttl` to a date years in the future to suppress doctor warnings —
  the condition for finality must be stated; a far TTL without one is a red
  flag in review.
- Conflating debt discharge (restoring V-model completeness) with feature
  work — a Refactor PLAN must not add new FR-driven functionality; add a
  separate `add-impl` PLAN for that.
