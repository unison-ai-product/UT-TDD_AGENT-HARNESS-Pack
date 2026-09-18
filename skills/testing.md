---
schema_version: skill.v1
name: testing
skill_type: testing
applies_to:
  layers:
    - L6
    - L7
    - L8
    - L9
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
decision_points:
  - when: "choosing the runner for CI or local test execution"
    choose: "npm run test (Vitest snapshot lane)"
    over: "bare vitest"
    because: "bare vitest bypasses the detached-HEAD snapshot fence"
  - when: "a PLAN proposes raising a coverage threshold in vitest.config.ts"
    choose: "confirm the new tests have meaningful oracles first"
    over: "raising the threshold once the percentage target is hit"
    because: "coverage count is not the same as oracle quality; a raised threshold can be satisfied by weak assertions"
  - when: "building fixtures for harness state in tests"
    choose: "dedicated fixtures under tests/fixtures/"
    over: "reusing production .ut-tdd/ state as a test fixture"
    because: "test runs must be reproducible without depending on a live runtime"
  - when: "an integration test needs to read harness.db"
    choose: "set up and tear down its own in-memory or temp-file DB instance"
    over: "reading the shared/production harness.db"
    because: "shared DB state makes test runs non-reproducible and can leak state between runs"
  - when: "a test suite reports high coverage percentage"
    choose: "verify the assertions would catch a wrong return value or a missing write to .ut-tdd/"
    over: "accepting the coverage percentage as evidence the tests are useful"
    because: "a green coverage percentage does not prove the test oracles are meaningful"
  - when: "a test (or code under test) spawns a Node/npm CLI as a child process and must pass on Windows CI"
    choose: "resolve the Node executable or npm `.cmd` entrypoint explicitly instead of relying on POSIX-only resolution"
    over: "spawning the bare command name and relying on POSIX-only resolution"
    because: "Windows package-manager commands may be `.cmd` shims and plain spawn resolution differs from POSIX; explicit entrypoints keep the suite consistent across native Windows and POSIX CI"
  - when: "back-filling tests for existing code under a Retrofit or Reverse PLAN"
    choose: "write characterisation tests describing current behavior before making any design changes"
    over: "changing the design first and writing tests against the new behavior"
    because: "characterisation tests establish the regression fence that protects existing behavior during the retrofit"
---

# testing

Test strategy, fixture design, and Vitest execution patterns across V-model
levels in UT-TDD. This skill covers the *what and how* of the test suite
architecture; for the *when* (Red-Green order, L6 pairing, trace-freeze),
see the test-driven-development skill.

## When to load this skill

- Designing or auditing test coverage for a PLAN before pair-freeze.
- Adding a new test level (unit / integration / system) to the suite.
- Investigating a `npm run test` failure that is not a simple assertion error.
- A Retrofit or Reverse PLAN needs to establish baseline coverage for
  existing code before back-filling design docs.

## Test levels in UT-TDD

| Level | V-model layer | Location | Scope |
|-------|---------------|----------|-------|
| Unit | L7 (paired with L6) | `tests/` | Single module, no I/O |
| Integration | L8 | `tests/integration/` | Two or more modules, real `.ut-tdd/` state |
| System / CLI | L9 | `tests/system/` | End-to-end `ut-tdd` command invocations |
| Acceptance | L11-L12 | `docs/test-design/acceptance/` | Scenarios against requirements |

Each level has a corresponding design doc in `docs/test-design/` paired with
its L5/L6 or L8/L9 design document. Level design docs must exist before the
tests are written (FR-L1-02 test-first applies at every level, not only unit).

## Vitest patterns

**Run the suite:**

```
npm run test           # Vitest — CI canonical runner
npm run test -- --watch   # local feedback loop
```

Never use bare `vitest` as a CI substitute — it bypasses the snapshot runner and produces
false failures on async Vitest suites.

**Scoped run for a PLAN:**

```
npm run test tests/<module>.test.ts
```

**Coverage (when adding a gate):**

Coverage thresholds live in `vitest.config.ts`. Do not raise thresholds without
confirming the substance of the new tests (coverage count is not the same as
oracle quality).

## Fixture discipline

- Fixtures for harness state live under `tests/fixtures/`. Do not reuse
  production `.ut-tdd/` state as a test fixture — test runs must be
  reproducible without a live runtime.
- Integration tests that read `harness.db` must set up and tear down their own
  in-memory or temp-file DB instance.
- External process calls (spawning `ut-tdd` CLI) must be wrapped with a helper
  that injects a controlled `CLAUDE_PROJECT_DIR` so hook paths resolve
  deterministically.

## Coverage vs. substance

A green coverage percentage does not prove the test oracles are meaningful.
After adding tests, ask: would this test catch a wrong return value? Would it
catch a missing write to `.ut-tdd/`? If not, strengthen the assertion before
declaring the coverage useful.

## L8 integration test checklist

- [ ] Test touches real `.ut-tdd/` state (temp dir, seeded fixture, or actual
  harness.db via a test helper).
- [ ] Test asserts on output artefacts (file written, DB row inserted, exit code)
  not only on console output.
- [ ] Teardown removes all temp state so subsequent runs are clean.
- [ ] Design doc in `docs/test-design/` references this test file.

## Retrofit / Reverse coverage baseline

When back-filling tests for existing code under a Retrofit or Reverse PLAN:

1. Run `npm run test` and record the current pass/fail state.
2. Identify the code paths to be covered using `ut-tdd graph impact --changed <path...>` or manual review.
3. Write characterisation tests (describe current behaviour as oracle) before
   any design changes — these become the regression fence.
4. Back-fill L6 unit-test design docs in `docs/test-design/` to pair with the
   characterisation tests.
5. Only then proceed with design changes or Forward-merge.
