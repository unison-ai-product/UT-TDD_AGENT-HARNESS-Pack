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
bun run typecheck      # tsc --noEmit, zero errors
bun run lint           # Biome check (format + lint), zero violations
bun run test           # Vitest — NOT bun test (its 5s sync timeout is flaky)
ut-tdd doctor          # fail-close over every harness gate
```

`bun run lint` runs Biome in check mode (format + lint). `biome lint` alone does
not check formatting — always use `bun run lint` before push.

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
