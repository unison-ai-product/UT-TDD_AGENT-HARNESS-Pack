---
schema_version: skill.v1
name: code-review-and-quality
skill_type: review
applies_to:
  layers:
    - L6
    - L7
    - L8
    - L9
    - L10
    - L11
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Refactor
    - Retrofit
---

# code review and quality

Combined review procedure that integrates W-gate test-perspective quality checks
with standard code review, satisfying FR-L1-21 (cross-agent review evidence) and
the quality requirements of FR-L1-03 (descent obligations) and FR-L1-18 (cross-
detection aggregation). Use when a PLAN spans both an implementation layer (L7)
and a test design layer (L6/L8), or when a Retrofit/Refactor PLAN must prove
quality is not regressed.

## When to load this skill

- A PLAN covers implementation (L7) and test design (L6/L8) in a single scope.
- A Retrofit PLAN must pass a quality bar before accept.
- A W-gate (W1-W10) pair is being closed and review evidence is required.
- `ut-tdd review --uncommitted` reports a test-design obligation gap.

## Quality bar definition (W-gate perspective)

Each W-gate pair (design doc <-> test or verification artifact) must satisfy:

| W-gate | Design side | Test side | Accept condition |
|--------|-------------|-----------|-----------------|
| W3 | L6 test-design doc | Vitest unit test file | All test IDs in L6 doc have matching test assertions; no `.skip` without rationale |
| W5 | L5 basic design | L8 integration test design | L8 doc exists at `docs/test-design/`; test IDs cross-reference L5 sections |
| W7 | L4 basic design | L9 system test design | L9 doc exists; acceptance criteria are testable |
| W10 | L3 functional spec | Curated test suite entry | Curation record in `.ut-tdd/` or `docs/test-design/` |

A W-gate is not closed by coverage count alone. Read the test-design doc body
to verify the specified scenarios are actually present.

## Combined review procedure

**Step 1 — Machine checks:**

```
bun run typecheck
bun run lint
bun run test
ut-tdd doctor
ut-tdd vmodel lint
ut-tdd review --uncommitted
```

All must exit 0 before proceeding.

**Step 2 — Test substance audit:**

For each test file in scope, verify:
- At least one test exercises a failure path (not only happy path).
- Boundary values from the L6 test-design doc are present as explicit fixtures.
- Mock scope is minimal; integration paths use a real test double, not a full
  database mock (FR-L1-03 descent obligation).

**Step 3 — Layer obligation check:**

Confirm the full V-model sibling set for every changed module:
- `docs/design/<layer>/<module>.md` exists.
- `docs/test-design/<layer>/<module>.md` exists.
- The PLAN `review_evidence` `trace_links` field lists both.

**Step 4 — Retrograde quality check (Refactor/Retrofit only):**

Run `ut-tdd metrics` (if available) or review the git diff for:
- No reduction in Vitest assertion count without PLAN rationale.
- No removal of an existing test-design doc section.
- Biome rule suppressions not increased beyond the pre-change count.

## Evidence record

```
reviewer: <agent-slug or "intra_runtime_subagent">
gate: trace-freeze | accept
quality_dimension: W-gate-<N>
outcome: PASS | FAIL | CONDITIONAL
findings:
  machine_checks: <all-pass | failing-command>
  test_substance: <finding or "none">
  layer_obligations: <finding or "none">
  retrograde: <finding or "none" | "N/A for non-Refactor">
timestamp: <ISO-8601>
```

## Anti-patterns

- Closing a W-gate by verifying only that a test file exists, not that it covers
  the scenarios in the paired design doc.
- Accepting a Refactor PLAN without the retrograde check — refactors frequently
  delete tests silently.
- Using `biome lint` alone instead of `bun run lint` — format violations
  accumulate and fail the next CI push.
