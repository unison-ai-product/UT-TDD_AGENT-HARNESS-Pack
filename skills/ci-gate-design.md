---
schema_version: skill.v1
name: ci-gate-design
skill_type: verification
applies_to:
  layers:
    - L7
    - L8
    - L9
    - L11
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Recovery
decision_points:
  - when: "A new class of defect (e.g., orphaned PLAN, roster/guard drift) is proposed as a new `ut-tdd doctor` check."
    choose: "First confirm `src/plan/lint.ts` and `src/doctor/` do not already cover it before implementing."
    over: "Adding the new gate directly without checking for overlap."
    because: "The skill states overlapping gates create false-confidence; a duplicate check can pass while masking the actual uncovered case."
  - when: "Designing what a new gate should detect."
    choose: "Design it to detect an absent or wrong artifact (fail-close on absence)."
    over: "Designing it to only confirm an ID or link is present (coverage-only check)."
    because: "The skill identifies absence-blindness as the root cause of descent gaps; a coverage-only gate proves an ID exists, not that the content behind it is correct."
  - when: "CI output is long and a failure needs triage."
    choose: "Read the full output."
    over: "Piping through `| tail` to see only the end of the log."
    because: "The skill explicitly warns truncation hides the root error; the real failing command is often earlier in the log than the final summary."
  - when: "A sub-gate fails and blocks the push."
    choose: "Fix the root cause in source, or file a PLAN-linked rationale if suppressing."
    over: "Silencing with `// biome-ignore`, `// @ts-ignore`, or `.skip` without justification."
    because: "Unlinked suppressions hide real defects from future review and accumulate as untracked technical debt."
  - when: "`npm run lint` and `biome lint` are both available as ways to check the code."
    choose: "Use `npm run lint` before push."
    over: "Running `biome lint` alone."
    because: "`biome lint` alone does not check formatting, so format violations pass locally and fail the next CI push."
  - when: "A check passes locally on code that should have failed."
    choose: "File an `improvement-backlog.md` entry and open a PLAN for the gate defect."
    over: "Treating the pass as valid and moving on."
    because: "A false-green is itself a gate defect per the skill's failure-response protocol, not a one-off fluke to ignore."
---

# ci gate design

Design and operation of the `harness-check` CI gate and the `ut-tdd doctor`
checks behind it. Apply when adding, modifying, or debugging any automated
quality gate (FR-L1-05 static gate, FR-L1-18 cross-detection aggregation).

## When to load this skill

- A PLAN adds a new `ut-tdd doctor` check or a `src/lint/` rule.
- `harness-check` is red and the root cause must be found.
- A gate condition is being designed for a layer transition (pair-freeze /
  trace-freeze / accept).

## harness-check composition

The canonical CI run is `harness-check`. Never skip a sub-gate to make CI pass.

```
npm run typecheck      # tsc --noEmit, zero errors
npm run lint           # Biome check (format + lint), zero violations
npm run test           # Vitest
ut-tdd doctor          # fail-close over every harness gate
```

`npm run lint` runs Biome in check mode (format + lint). `biome lint` alone does
not check formatting — always use `npm run lint` before push.

## When a new gate is warranted

Add a gate when a class of defect is mechanically detectable and currently slips
past review (substance gap, orphaned PLAN, roster↔guard drift). First confirm
`src/plan/lint.ts` and `src/doctor/` do not already cover it — overlapping gates
create false-confidence (plan-governance already checks PLAN dependency
existence). Implement under `src/lint/` or the doctor surface, wire it into
`ut-tdd doctor`, and add a Vitest test exercising both the pass and the fail
path.

## A gate must see substance, not just coverage

A coverage check (ID present, link exists, count matches) does not prove the
content is correct. When designing a gate, ask: can it detect an *absent* or
*wrong* artifact, or only a missing ID? Prefer fail-close on absence
(absence-blindness is the root cause of descent gaps).

## Failure response protocol

1. Read the **full** output — never `| tail`. Truncation hides the root error.
2. Identify the failed sub-gate (typecheck / lint / test / doctor).
3. Fix the root cause in source. Do not silence with `// biome-ignore`,
   `// @ts-ignore`, or `.skip` without a PLAN-linked rationale.
4. Re-run the full sequence locally before pushing.
5. If a check passed that should have failed, file an `improvement-backlog.md`
   entry and open a PLAN — a false-green is a gate defect.

## Environment notes (Windows / Linux parity)

- `CLAUDE_PROJECT_DIR` must point to the repo root during hook execution.
- If `System32` is missing from the runner `PATH`, runtime hook entrypoints fail
  with status null; verify with `ut-tdd doctor` before treating it as a code
  regression.

## L8 integration test design for a new gate

- [ ] Gate fires and records its result row in `harness.db`.
- [ ] Gate exits 1 on a seeded violation fixture.
- [ ] Gate exits 0 on a clean fixture.

Record the L8 design under `docs/test-design/` paired with the L5/L6 design doc;
these are distinct from the L7 Vitest unit tests.
