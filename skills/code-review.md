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
decision_points:
  - when: "The pre-review checklist (typecheck/lint/test/doctor/review) has any failing command."
    choose: "Surface the failure to the author before opening any file for review."
    over: "Reviewing the code anyway and noting the build failure alongside design findings."
    because: "The skill states reviewing broken code conflates build errors with review findings, muddying which issues are genuine review defects."
  - when: "Axis 1 review finds implementation behavior that diverges from the documented L5/L6 design doc contract."
    choose: "Record it as a defect."
    over: "Treating it as an acceptable judgement call by the implementer."
    because: "The skill explicitly states a deviation from the design doc is a defect, not a judgement call — design docs are the contract, not a suggestion."
  - when: "An FR cited in the PLAN's `review_evidence` has no design-doc section or test file tracing to it (Axis 3)."
    choose: "Mark it as an open obligation."
    over: "Treating the FR as completed because it is listed in review_evidence."
    because: "Listing an FR in review_evidence is a claim, not proof; the skill requires an actual downstream artifact to close the trace."
  - when: "A reviewer wants to record a CONDITIONAL outcome for a review finding."
    choose: "Include a follow-up PLAN reference alongside the CONDITIONAL outcome."
    over: "Recording CONDITIONAL alone without a linked follow-up."
    because: "The skill states a CONDITIONAL outcome without a follow-up PLAN reference is treated as FAIL — unlinked conditions have no enforcement path."
  - when: "Running in hybrid mode versus single-runtime mode for the review step."
    choose: "Dispatch to a separate code-reviewer subagent via `ut-tdd claude --role code-reviewer` in hybrid mode."
    over: "Performing the five-axis review in the same session/runtime that implemented the change."
    because: "Cross-agent review evidence (FR-L1-21) requires an independent check; single-runtime mode is only the fallback, recorded explicitly as `intra_runtime_subagent`."
---

# code review

Five-axis review procedure for UT-TDD implementation artifacts at trace-freeze
and accept gates (FR-L1-13 Forward workflow, FR-L1-21 review evidence). Applies
whenever `ut-tdd review --uncommitted` is the entry point or a PLAN's accept
gate requires recorded review findings.

## When to load this skill

Boundary: this skill owns the general five-axis review at trace-freeze / accept.
W-gate (design <-> test) pair closure and Refactor/Retrofit quality-bar
judgement are owned by `code-review-and-quality.md` — non-overlapping
responsibilities; load both when a PLAN needs both.

- Entering the trace-freeze gate of any Forward or Add-feature PLAN.
- A Recovery or Refactor PLAN requires evidence that the change does not
  introduce new defects.
- A code-reviewer subagent is dispatched via `ut-tdd claude --role code-reviewer`.

## Pre-review checklist

Run these before opening any file:

```
npm run typecheck
npm run lint
npm run test
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
