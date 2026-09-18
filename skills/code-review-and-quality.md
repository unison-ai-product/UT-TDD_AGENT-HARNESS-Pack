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
decision_points:
  - when: "Choosing between this skill and the general `code-review` skill for a review task."
    choose: "Use this skill for W-gate (design <-> test) pair closure and Refactor/Retrofit quality-bar judgement; use `code-review` for the general five-axis review at trace-freeze / accept. They are non-overlapping responsibilities — apply both when a PLAN needs both."
    over: "Picking one of the two interchangeably because their layers and drive models overlap."
    because: "The two packs share applies_to layers/drives and rank near-identically in skill recommendation; without this boundary the injector and the reviewer cannot tell which procedure is owed."
  - when: "A W-gate pair (design doc <-> test/verification artifact) is being closed for accept."
    choose: "Read the test-design doc body to confirm the specified scenarios are actually present in the test file."
    over: "Closing the gate because the test-ID count matches the design-doc scenario count."
    because: "The skill states a W-gate is not closed by coverage count alone; a matching count can still map onto trivial or wrong assertions."
  - when: "Verifying integration-path test doubles for the Step 2 substance audit."
    choose: "Confirm integration paths use a real test double."
    over: "Accepting a full database mock as sufficient integration coverage."
    because: "FR-L1-03's descent obligation requires integration tests to exercise real behavior; a full mock can pass while the real integration path is broken."
  - when: "Reviewing a Refactor or Retrofit PLAN for accept."
    choose: "Run the Step 4 retrograde quality check (assertion count, test-design section removal, suppression count) before approving."
    over: "Treating the standard Step 1-3 review as sufficient since no new feature is being added."
    because: "The skill notes refactors frequently delete tests silently; skipping the retrograde check specifically misses quality regressions that a same-scope review would not catch."
  - when: "A changed module's V-model sibling artifacts (design doc, test-design doc, trace_links) are being checked."
    choose: "Confirm all three exist and are referenced in `review_evidence.trace_links`, not just the code change itself."
    over: "Approving the PLAN because the implementation and its direct unit test are present."
    because: "FR-L1-21 review evidence and the layer obligation check require the full sibling set; a missing design or test-design doc is an open V-model obligation even if the code works."
  - when: "A commit uses `biome lint` instead of `npm run lint` before the review is closed."
    choose: "Flag it as an anti-pattern and require `npm run lint`."
    over: "Accepting it since `biome lint` also reports lint violations."
    because: "The skill lists this exact substitution as an anti-pattern: format violations accumulate silently and fail the next CI push."
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
npm run typecheck
npm run lint
npm run test
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

Run `ut-tdd metrics skill` or review the git diff for:
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
- Using `biome lint` alone instead of `npm run lint` — format violations
  accumulate and fail the next CI push.
