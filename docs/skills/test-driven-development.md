---
schema_version: skill.v1
name: test-driven-development
skill_type: testing
applies_to:
  layers:
    - L6
    - L7
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Refactor
---

# test driven development

Red-first TDD discipline for UT-TDD (FR-L1-02 test-first implementation order,
FR-L1-50 strict TDD/DDD enforcement). A test that is written after the
implementation it exercises provides zero design signal and weaker oracle value
— the cycle order is non-negotiable in this harness.

## When to load this skill

- Crossing pair-freeze into L7 implementation for any Forward or Add-feature PLAN.
- A Refactor PLAN must re-confirm regression coverage before touching source.
- A Reverse back-fill requires test-first evidence for an existing code path.
- `ut-tdd doctor` or `ut-tdd review --uncommitted` flags a missing test or a
  test that post-dates its implementation commit.

## Red-Green-Refactor cycle (UT-TDD order)

### 1. Red — write the failing test first

- Derive the test contract from the L6 unit-test design doc paired with the
  PLAN. The L6 doc must exist and be readable before any test is written.
- Write one `describe` / `it` block in `tests/` that exercises a single
  behaviour. Run `bun run test` and confirm the test **fails** (Red).
- If the test passes before any source change it is either a vacuous assertion
  or the feature already exists — both require investigation, not celebration.
- Commit the failing test as a standalone commit so the Red evidence is in git
  history (FR-L1-02 traceability requirement).

### 2. Green — write the minimum source to pass

- Add only the implementation required to make the new test(s) pass. Do not
  add untested surface area.
- Run `bun run test` again; confirm all prior tests still pass and the new
  test is now Green.
- Run `bun run typecheck` and `bun run lint` — no new violations permitted.
- Run `ut-tdd doctor` — governance must stay clean.

### 3. Refactor — improve structure while tests stay Green

- Rename, extract, or reorganise source and tests. No behaviour changes.
- Re-run the full suite (`bun run typecheck && bun run lint && bun run test &&
  ut-tdd doctor`) after every structural change.
- If any test turns Red, stop and revert the last change.

## Trace-freeze checklist (before review gate)

- [ ] Each new test file maps to an L6 unit-test design entry in
  `docs/test-design/`.
- [ ] PLAN `review_evidence` contains a reference to the failing-commit SHA.
- [ ] `bun run test` exits 0 with no `.skip` or `.todo` left open without a
  PLAN-linked rationale.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` exits 0 (Biome check — format + lint, not `biome lint` alone).
- [ ] `ut-tdd doctor` exits 0.
- [ ] `ut-tdd review --uncommitted` produces no blocking findings for L7.

## Oracle strength rules

- Assert exact values or structural equality where deterministic. Avoid
  `toBeTruthy()` on complex objects — it passes for any non-null value.
- Mock only at process boundaries (I/O, network, DB). Do not mock the unit
  under test.
- Integration paths (`tests/integration/`) must hit real harness state
  (`.ut-tdd/`, `harness.db`), never mocked replacements — a prior incident
  showed mock/real divergence masking a broken migration path.

## Anti-patterns

- Writing `it.todo` as a placeholder, then implementing source first and filling
  the test in later — this inverts the cycle order and forfeits Red evidence.
- Running `bun test` instead of `bun run test` — the native runner has a 5-second
  sync timeout that makes some async tests flaky without reflecting real failures.
- Treating `ut-tdd doctor` green as evidence that the test design is correct —
  doctor checks structural governance, not oracle quality or cycle order.
