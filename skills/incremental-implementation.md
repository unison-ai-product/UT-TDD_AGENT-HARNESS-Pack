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
decision_points:
  - when: "an L5 design doc or L6 test design doc is missing before writing a new module"
    choose: "stop and resolve the design gap as an unresolved PLAN `requires` before writing source"
    over: "write the source file first and backfill the design doc afterward"
    because: "`ut-tdd doctor` checks structural link existence but not substance, so writing ahead creates descent obligation debt that goes undetected"
  - when: "an external input's type cannot be immediately narrowed (parsed JSON, CLI args)"
    choose: "type it `unknown` and narrow with a type guard before use"
    over: "type it `any` to unblock compilation quickly"
    because: "`any` without a PLAN-linked rationale is forbidden and silently defeats `npm run typecheck` as a safety gate"
  - when: "a function reads state, transforms it, and writes output in one body"
    choose: "split into three functions with distinct names, separating I/O from computation"
    over: "keep it as one function for brevity"
    because: "functions mixing I/O with computation make unit tests dependent on file system state, turning a unit test into an integration test"
  - when: "multiple small features are ready to commit at once"
    choose: "commit each Red-to-Green step separately, one commit per advancing test"
    over: "batch multiple feature commits into one to reduce commit noise"
    because: "the Red-commit/Green-commit sequence is required audit evidence (FR-L1-02); batching destroys the trace"
  - when: "a Biome lint rule fires on generated or awkward code"
    choose: "fix the underlying formatting/lint issue or document a PLAN-linked rationale for suppressing it"
    over: "add `// biome-ignore` without explanation to unblock the commit"
    because: "unexplained biome-ignore comments accumulate silently and break CI on a later push when the suppressed rule finally matters"
  - when: "a function body is approaching or exceeding 30 lines"
    choose: "extract a named helper, and document the extraction in the L5 spec if it introduces a new concept"
    over: "leave the function long because it still 'reads fine'"
    because: "the 30-line guideline exists to keep single-responsibility enforceable; undocumented extractions also break L5/L6 descent traceability"
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
- `npm run typecheck` must exit 0 after every commit — do not accumulate type
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
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0 (Biome check — format + lint).
- [ ] `npm run test` exits 0 with no `.skip` or `.todo` left open without a
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
