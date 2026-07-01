---
schema_version: skill.v1
name: gate-planning
skill_type: process
applies_to:
  layers:
    - L1
    - L3
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Scrum
    - Discovery
---

# gate planning

How to author and enforce Definition-of-Done (DoD) gates in UT-TDD (FR-L1-05
deterministic static gate, FR-L1-13 Forward workflow). A gate is a
machine-checked boundary, not a skippable checklist — unenforced gates
accumulate false-green state and hide V-model descent gaps.

## When to load this skill

- Designing the acceptance conditions for a PLAN or a layer transition.
- A `ut-tdd doctor` failure exposes a condition that is not machine-checked.
- A Scrum S3 verify step needs explicit DoD before S4 decide.
- A pair-freeze / trace-freeze / accept gate is being crossed.

## UT-TDD Definition-of-Done

A unit of work is complete only when ALL hold:

1. `bun run typecheck`, `bun run lint` (Biome check), and `bun run test`
   (Vitest) are green.
2. `ut-tdd doctor` exits 0 (no governance violation).
3. `ut-tdd plan lint` exits 0 (PLAN schema valid, dependencies exist,
   `§工程表` schedule section checked).
4. `ut-tdd review --uncommitted` produces no blocking findings for the layer.
5. The layer's design doc passes the freeze readability check (Objective,
   Scope, no mojibake).
6. New terms are added to the L0 glossary.
7. Handover evidence is written to `.ut-tdd/handover/` when the task crosses a
   session boundary.

"Code written" and "looks right" are not DoD. Only machine evidence and recorded
review findings clear a gate.

## Gate design rules

- **Falsifiable condition.** "Passes review" is not falsifiable; "`ut-tdd
  doctor` exits 0 and `bun run test` passes with no skipped tests" is.
- **Name the checking command.** Every condition maps to a `ut-tdd`/CI command
  or an explicit human review action.
- **Record the result, not the intent.** Evidence goes into `.ut-tdd/audit/` or
  the PLAN `review_evidence` field; a gate with no recorded evidence is not
  cleared.
- **Split correctness from readability.** Schema-valid (`ut-tdd plan lint`) and
  readable (manual / `ut-tdd review --uncommitted`) are separate checks.

## Layer gate checklists

**pair-freeze (design → implement):** PLAN `status` ready; design doc exists at
the right `docs/design/` path and passes readability; `ut-tdd plan lint` and
`ut-tdd doctor` exit 0; no unresolved `requires` dependency.

**trace-freeze (implement → review):** PLAN-scoped source committed; Vitest green
with no skipped tests in scope; Biome check + typecheck exit 0; `ut-tdd doctor`
exit 0; `review_evidence` trace links populated.

**accept (review → done):** `ut-tdd review --uncommitted` no blocking findings;
trace-freeze conditions still green on HEAD; new ADR set to `Accepted`; handover
updated or closed.

## Mode-aware review tier

`ut-tdd gate <id>` reads the execution mode from `ut-tdd status`. Judgement gates
require cross-agent review evidence in hybrid mode, or `intra_runtime_subagent`
evidence in single-runtime mode — never self-review alone.

## Anti-patterns that defeat enforcement

- `bun test` instead of `bun run test` (Vitest) — native runner has sync-timeout
  flakiness; CI uses Vitest.
- `biome lint` without `biome check` — format violations accumulate and break the
  next push.
- Treating `ut-tdd doctor` green as "design is correct" — doctor checks
  structural governance, not design substance. Read the docs.
- Silencing with `// biome-ignore`, `// @ts-ignore`, or `.skip` without a
  PLAN-linked rationale.
