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
decision_points:
  - when: "crossing pair-freeze into L7 implementation"
    choose: "write the failing test first and commit it as standalone Red evidence"
    over: "implementing the source first and back-filling the test"
    because: "a test written after its implementation provides zero design signal and forfeits Red evidence required by FR-L1-02"
  - when: "a newly written test passes before any source change"
    choose: "stop and investigate whether the assertion is vacuous or the feature already exists"
    over: "treating an unexpected early pass as a success to move past"
    because: "an unexplained pass hides either a weak oracle or duplicate implementation, both of which corrupt the Red-Green record"
  - when: "a refactor step turns a previously Green test Red"
    choose: "stop immediately and revert the last change"
    over: "continuing to refactor and fixing tests afterward"
    because: "Refactor must preserve behavior; a Red test during refactor means behavior changed, which is out of scope for that step"
  - when: "deciding what to mock in a unit test"
    choose: "mock only process boundaries (I/O, network, DB)"
    over: "mocking the unit under test itself"
    because: "mocking the unit under test removes the thing the test is supposed to verify"
  - when: "writing integration tests under tests/integration/"
    choose: "exercise real harness state (.ut-tdd/, harness.db)"
    over: "using mocked replacements for harness state"
    because: "a prior incident showed mock/real divergence masking a broken migration path"
  - when: "choosing the test-run command for CI or local verification"
    choose: "npm run test"
    over: "an unspecified test command"
    because: "the repository's canonical test script invokes the deterministic Vitest snapshot runner"
---

# test driven development

Red-first TDD discipline for UT-TDD (FR-L1-02 test-first implementation order,
FR-L1-50 strict TDD/DDD enforcement). A test that is written after the
implementation it exercises provides zero design signal and weaker oracle value
— the cycle order is non-negotiable in this harness.

## When to load this skill

- Crossing pair-freeze into L7 implementation for any Forward or Add-feature Issue.
- A Refactor Issue (with its design document) must re-confirm regression coverage before touching source.
- A Reverse back-fill requires test-first evidence for an existing code path.
- `ut-tdd doctor` or `ut-tdd review --uncommitted` flags a missing test or a
  test that post-dates its implementation commit.

## Red-Green-Refactor cycle (UT-TDD order)

How the three steps map to PRs in this repository (issue #968; the design-protection gate,
`docs/design/harness/L6-function-design/design-protection-diff-gate.md` §10.2, compares only
the base and head path sets and does not see commits, so the order is a review rule):

| Step | Where | Commit type | What may change |
|---|---|---|---|
| Red | contract PR + Red (no `src/` / `scripts/`) | `test:` | test design promotion and `it.fails` tests |
| Green | implementation PR, first commits | `feat:` / `fix:` | minimal source; `it.fails` back to `it` |
| Refactor | implementation PR, after Green | `refactor:` | source structure only; `tests/` content diff 0 (renames only); no test design |

If there is nothing to refactor, say "Refactor なし" with the reason in the PR body; do not skip
silently. The conditions that justify "Refactor なし" and who judges them are defined in
`docs/governance/coding-rules.md` §量・分割・Refactor の目安 (the canonical source). Large structural
changes go to a Refactor Issue (label `refactor`) and a design document, and the code-simplify skill.
The non-author reviewer checks the commit order and that the Refactor commits leave `tests/`
content unchanged.

### 1. Red — write the failing test first

- Derive the test contract from the L6 unit-test design doc paired with the
  Issue. The L6 doc must exist and be readable before any test is written.
- Write one `describe` / `it` block in `tests/` that exercises a single
  behaviour. Run `npm run test` and confirm the test **fails** (Red).
- If the test passes before any source change it is either a vacuous assertion
  or the feature already exists — both require investigation, not celebration.
- Commit the failing test as a standalone commit so the Red evidence is in git
  history (FR-L1-02 traceability requirement). In this repository the Red tests
  land in the contract PR + Red as `it.fails`, so `main` CI stays Green.

### 2. Green — write the minimum source to pass

- Add only the implementation required to make the new test(s) pass. Do not
  add untested surface area.
- Run `npm run test` again; confirm all prior tests still pass and the new
  test is now Green.
- Run `npm run typecheck` and `npm run lint` — no new violations permitted.
- Run `ut-tdd doctor` — governance must stay clean.

### 3. Refactor — improve structure while tests stay Green

- Rename, extract, or reorganise source. No behaviour changes. Test files may be
  renamed or moved, but their assertions and contents stay identical (`tests/`
  content diff 0); changing a test is not a refactor.
- Use `refactor:` commits after the Green commits in the same implementation PR.
- Re-run the full suite (`npm run typecheck && npm run lint && npm run test &&
  ut-tdd doctor`) after every structural change.
- If any test turns Red, stop and revert the last change.

## Trace-freeze checklist (before review gate)

- [ ] Each new test file maps to an L6 unit-test design entry in
  `docs/test-design/`.
- [ ] PR review evidence contains a reference to the failing-commit SHA.
- [ ] `npm run test` exits 0 with no `.skip` or `.todo` left open without a
  Issue-linked rationale.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0 (Biome check — format + lint, not `biome lint` alone).
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
- Running an unspecified test command instead of the repository's canonical `npm run test` script.
- Treating `ut-tdd doctor` green as evidence that the test design is correct —
  doctor checks structural governance, not oracle quality or cycle order.
- Bypassing the Vitest snapshot guard by hand-setting its env vars: forbidden; the rule lives in
  `CLAUDE.md` §Shared Guard Discipline (Vitest の snapshot guard を env で迂回しない).
