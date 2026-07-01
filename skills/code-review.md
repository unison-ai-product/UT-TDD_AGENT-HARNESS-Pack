---
schema_version: skill.v1
name: code-review
skill_type: review
applies_to:
  layers:
    - L5
    - L6
    - L7
    - L8
    - L10
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Recovery
    - Refactor
---

# code review

Five-axis review procedure for UT-TDD implementation artifacts at trace-freeze
and accept gates (FR-L1-13 Forward workflow, FR-L1-21 review evidence). Applies
whenever `ut-tdd review --uncommitted` is the entry point or a PLAN's accept
gate requires recorded review findings.

## When to load this skill

- Entering the trace-freeze gate of any Forward or Add-feature PLAN.
- A Recovery or Refactor PLAN requires evidence that the change does not
  introduce new defects.
- A code-reviewer subagent is dispatched via `ut-tdd claude --role code-reviewer`.

## Pre-review checklist

Run these before opening any file:

```
bun run typecheck
bun run lint
bun run test
ut-tdd doctor
ut-tdd review --uncommitted
```

All must exit 0. If any fail, surface the failure to the author before
proceeding — reviewing broken code conflates build errors with review findings.

## Five review axes

### Axis 1 — Correctness vs. design intent

Read the L5/L6 design doc for the scope under review. Verify each public
function or module against its documented contract. A deviation from the design
doc is a defect, not a judgement call.

### Axis 2 — Test coverage substance

Confirm Vitest tests are asserting the specified behaviour, not just exercising
code paths. Check: are boundary conditions from the L6 test-design doc present?
Is the pass/fail fixture pair present for every gate-relevant path? Count skipped
tests; each needs a PLAN-linked rationale.

### Axis 3 — Trace completeness

Verify that every FR cited in the PLAN `review_evidence` traces to a design doc
section or a test file. An FR ID with no downstream artifact is an open
obligation, not completed work.

### Axis 4 — V-model layer obligations

Confirm the expected sibling artifacts are present:
- L7 implementation -> L6 test-design doc must exist at `docs/test-design/`.
- L8 integration test design -> matching L5 basic design doc must exist.
- New term used in code -> L0 glossary entry must exist.

### Axis 5 — Operational hygiene

- No unexplained `// biome-ignore`, `// @ts-ignore`, or suppression comments.
- No hardcoded paths, secrets, or credentials.
- No dead code left as technical debt without a PLAN-linked `TODO`.
- Conventional Commits message on the commit in scope.

## Recording review findings

Populate the PLAN `review_evidence` field with:

```
reviewer: <agent-slug or "intra_runtime_subagent">
gate: trace-freeze | accept
outcome: PASS | FAIL | CONDITIONAL
axis_findings:
  correctness: <finding or "none">
  coverage: <finding or "none">
  trace: <finding or "none">
  layer_obligations: <finding or "none">
  hygiene: <finding or "none">
timestamp: <ISO-8601>
```

A CONDITIONAL outcome must include a follow-up PLAN reference or the gate is
treated as FAIL.

## Dispatch pattern

In hybrid mode, dispatch to a separate subagent family:

```
ut-tdd claude --role code-reviewer --task "review PLAN-<id> at trace-freeze" --execute
```

In single-runtime mode, record `intra_runtime_subagent` as the reviewer
identity and perform the five-axis procedure above in full.
