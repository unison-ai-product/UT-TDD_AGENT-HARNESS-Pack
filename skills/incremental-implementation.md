---
schema_version: skill.v1
name: incremental-implementation
skill_type: process
applies_to:
  layers:
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Retrofit
---

# incremental implementation

L7 implementation quality baseline for UT-TDD: type safety, naming discipline,
function design, and descent obligation. Covers the period from pair-freeze to
trace-freeze on a PLAN. Does not replace the TDD cycle order (see
test-driven-development skill) — these rules apply *within* each Red-Green step.

## When to load this skill

- Starting L7 implementation after pair-freeze (L5/L6 design docs exist,
  `ut-tdd plan lint` and `ut-tdd doctor` are green).
- A code review (`ut-tdd review --uncommitted`) flags a type, naming, or
  design quality issue.
- A Refactor or Retrofit PLAN is scoping what source changes are in-bounds.

## Descent obligation

Every L7 source file must trace to an L5 detailed design doc and an L6
unit-test design doc. Before writing a new module:

1. Confirm `docs/design/L5-<module>.md` exists and has passed pair-freeze.
2. Confirm `docs/test-design/L6-<module>.md` exists and references the test
   file to be written.
3. If either is absent, the PLAN has an unresolved `requires` — stop and
   resolve the design gap before writing source.

`ut-tdd doctor` checks structural link existence but not substance. Read the L5
doc and confirm it answers the implementation questions before coding.

## Type safety rules

- No `any` without a PLAN-linked comment explaining why the type cannot be
  narrowed. `// @ts-ignore` is forbidden without the same rationale.
- Use TypeScript discriminated unions for multi-shape return values; avoid
  `T | null | undefined` where a `Result<T, E>` pattern is cleaner.
- Prefer `unknown` over `any` for external inputs (parsed JSON, CLI args).
  Narrow with a type guard before use.
- `bun run typecheck` must exit 0 after every commit — do not accumulate type
  debt across commits.

## Naming discipline

- Function names are imperative verbs describing the action: `recordGuardrail`,
  `readPlanFile`, `emitProjectionRow`. Avoid noun forms (`guardrailRecorder`).
- Boolean return values use `is*` / `has*` / `can*` prefixes.
- File names match the primary export: `projection-writer.ts` exports
  `ProjectionWriter` or `writeProjection`.
- New terms introduced in source must be added to `docs/design/L0-glossary.md`
  at the same commit.

## Function design constraints

- A function has one responsibility. If a function reads state, transforms it,
  and writes output, split into three functions with distinct names.
- Functions that write to `.ut-tdd/` or `harness.db` must not also compute
  business logic — separate I/O from computation so unit tests can exercise
  computation without side effects.
- Public API surface (exported functions and types) must be the minimal set
  needed by tests and callers. Do not export internal helpers.
- Maximum recommended function body: 30 lines. Beyond that, extract a named
  helper and document the extraction in the L5 spec if the helper represents
  a new concept.

## Incremental commit discipline

- Each commit advances a Red test to Green (or refactors while staying Green).
  Do not batch multiple feature commits to reduce noise — the Red-commit/
  Green-commit sequence is audit evidence (FR-L1-02).
- Stage explicit files only (`git add <file>`, never `git add -A`).
- Commit messages follow Conventional Commits: `feat(module): description`,
  `test(module): description`, `refactor(module): description`.

## Trace-freeze checklist

- [ ] All new source files have a paired L5 design doc and L6 test design doc.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` exits 0 (Biome check — format + lint).
- [ ] `bun run test` exits 0 with no `.skip` or `.todo` left open without a
  PLAN-linked rationale.
- [ ] `ut-tdd doctor` exits 0.
- [ ] New terms added to L0 glossary.
- [ ] PLAN `review_evidence` references the trace-freeze commit SHA.
- [ ] `ut-tdd review --uncommitted` produces no blocking findings for L7.

## Anti-patterns

- Writing source files without a paired L5/L6 doc — creates descent obligation
  debt that `ut-tdd doctor` may not immediately surface.
- Mixing I/O with computation in one function — makes unit tests dependent on
  file system state, which is an integration concern.
- Using `// biome-ignore` to silence a formatting rule without a rationale —
  these accumulate and break CI on the next push.
