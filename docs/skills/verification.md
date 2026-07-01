---
schema_version: skill.v1
name: verification
skill_type: verification
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L4
    - L5
    - L6
    - L7
    - L8
    - L9
    - L11
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Discovery
    - Scrum
    - Recovery
---

# verification

V-model trace verification: confirming that every design artifact descends
correctly to an implementation and test artifact, and that machine checks reflect
real substance (not just ID coverage). Supports FR-L1-03 (descent obligations),
FR-L1-18 (cross-detection aggregation), and FR-L1-21 (review evidence).

## When to load this skill

- A Forward or Add-feature cycle completes a layer group and the descent
  verification cycle is triggered.
- `ut-tdd doctor` exits non-zero with a descent or orphan finding.
- `ut-tdd vmodel lint` reports an unsatisfied obligation.
- A Scrum S3 verify step requires V-model completeness evidence.
- A Recovery cycle must prove the gap that caused the incident is now closed.

## Verification is substance, not coverage

Coverage checks (fr-registry link exists, pair-freeze orphan count = 0) confirm
ID registration, not content correctness. A verification pass requires reading
the design doc to confirm the claim it makes is substantiated in the body.
"Coverage = 0 orphans" and "descent = design is correct" are separate claims.

## Machine verification sequence

Run in order; stop at the first failure and fix before continuing:

```
ut-tdd doctor              # structural governance: orphans, missing pairs, PLAN schema
ut-tdd vmodel lint         # V-model layer obligations: absence-fail-close
ut-tdd plan lint           # PLAN schema, dependency existence, schedule section
bun run typecheck          # TypeScript: zero errors
bun run lint               # Biome check: format + lint, zero violations
bun run test               # Vitest: no skipped tests without rationale
```

Never pipe any of these through `| tail` — truncation hides the root error.

## Descent verification by layer group

**L0-L3 (concept through functional design):**
- L1 requirements doc exists and each FR has a unique ID.
- L3 functional spec exists for each FR; body is not placeholder prose.
- `ut-tdd vmodel lint` reports no L3 obligation gap.

**L4-L6 (basic design through unit-test design):**
- L5 detailed design doc exists at `docs/design/L5/` for each PLAN in scope.
- L6 test-design doc exists at `docs/test-design/L6/` for each module.
- L6 test-design lists explicit scenario IDs that match Vitest `describe`/`it`
  names. Absence of a matching test = open obligation, not a pass.

**L7 (implementation):**
- Vitest assertions exercise the scenarios in the paired L6 doc.
- No `.skip`, `todo`, or `@ts-ignore` without a PLAN-linked rationale in a
  comment on the same line.
- `harness.db` projection row for the PLAN is in `completed` or `review` state.

**L8-L9 (integration and system test design):**
- L8 integration test design doc exists at `docs/test-design/L8/`.
- L8 doc cross-references the L5 basic design section it covers.
- Gate exits 1 on a seeded violation fixture (not only on green).

## Obligation absence rule

An absent artifact is a violation, not a neutral state. If a design doc exists
but its paired test-design doc is missing, `ut-tdd vmodel lint` should report
it as a gap. If the lint does not catch it, file an improvement entry — absence-
blindness is the root cause of descent gaps.

## Evidence record

At the completion of a layer-group verification cycle, write:

```
.ut-tdd/audit/<PLAN-id>-verification-<layer-group>.json
{
  "plan_id": "<id>",
  "layer_group": "L0-L3 | L4-L6 | L7 | L8-L9",
  "machine_checks": "all-pass | <failing command>",
  "descent_findings": ["<finding>" | "none"],
  "substance_checked": true | false,
  "outcome": "PASS | FAIL | CONDITIONAL",
  "reviewer": "<agent-slug or intra_runtime_subagent>",
  "timestamp": "<ISO-8601>"
}
```

## Anti-patterns

- Declaring a layer group complete because `ut-tdd doctor` exits 0 — doctor
  checks structure, not design substance.
- Using Vitest assertion count as a proxy for test quality — verify the
  scenario IDs match the L6 design doc.
- Skipping the L8 test-design doc because "unit tests are sufficient" —
  V-model requires paired artifacts at every boundary.
