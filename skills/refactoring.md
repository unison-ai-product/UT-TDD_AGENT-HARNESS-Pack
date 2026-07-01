---
schema_version: skill.v1
name: refactoring
skill_type: process
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Refactor
    - Forward
    - Add-feature
---

# refactoring

Behaviour-invariant code improvement under the Refactor drive model (FR-L1-25).
A Refactor PLAN changes structure without changing externally observable
behaviour. Any change that alters a public API, a `.ut-tdd/` state artefact,
or a `harness.db` schema is not refactoring — it is an Add-feature or Retrofit
and must be routed accordingly.

## When to load this skill

- A PLAN has `drive: Refactor` or `kind: refactor`.
- A `ut-tdd review --uncommitted` finding flags dead code, an oversized
  function, or a naming violation that should be cleaned up.
- An Add-feature PLAN includes an internal cleanup step that must not change
  observable behaviour.

## Scope check before starting

Before writing a single line, answer these questions:

1. What is the **observable boundary** of the code being changed? (Exported
   functions, CLI exit codes, files written to `.ut-tdd/`, DB rows.)
2. Does the current test suite cover all observable boundary behaviours? Run
   `bun run test` and confirm coverage. If not, write characterisation tests
   first (see testing skill) — a refactor without a regression fence is a
   behaviour change with no safety net.
3. Is the PLAN's `kind` value `refactor`? If `kind=add-impl` is present, the
   PLAN carries a Reverse pairing obligation that must be honoured.

## Refactor cycle

### Step 1 — establish a regression fence

Run `bun run test` and record the baseline pass count. If any test is `.skip`
or `.todo` in the scope of the refactor, either un-skip it or file a PLAN to
address it. Proceed only when the fence is complete and Green.

### Step 2 — make one structural change

Each commit should make exactly one structural change: rename a function,
extract a helper, collapse two equivalent branches, remove dead code. Run
the full gate sequence after each change:

```
bun run typecheck && bun run lint && bun run test && ut-tdd doctor
```

If any gate turns Red, revert the last change before proceeding. Do not
accumulate multiple structural changes across a Red gate.

### Step 3 — confirm behaviour invariance

- `bun run test` passes with the same number of Green tests as the baseline
  (no tests added or removed during refactor — only during subsequent
  Add-feature or TDD work).
- `ut-tdd doctor` exits 0.
- If the refactor touches a public export signature, run
  `ut-tdd review --uncommitted` to confirm no downstream breakage.

### Step 4 — update design docs

If the refactor changes module structure (file rename, extraction of a new
module), update the paired L5 design doc and L6 test design doc to reflect the
new structure. A source file without a paired design doc after a refactor is
a descent obligation gap.

## kind=refactor PLAN checklist

- [ ] Regression fence is Green before first structural commit.
- [ ] Each commit contains exactly one structural change.
- [ ] `bun run typecheck && bun run lint && bun run test && ut-tdd doctor` green
  after every commit.
- [ ] No new exported API surface added (would require Add-feature routing).
- [ ] No `.ut-tdd/` state schema or `harness.db` schema changed.
- [ ] L5/L6 design docs updated to match new structure.
- [ ] PLAN `review_evidence` records the trace-freeze SHA.
- [ ] `ut-tdd review --uncommitted` no blocking findings.

## Anti-patterns

- Combining a refactor with a feature addition in the same commit — these are
  separate concerns with separate review obligations; mix them and the
  regression fence is invalidated.
- Adding tests during the refactor to improve coverage — this is a TDD step,
  not a refactor step; route it to a separate Add-feature or Reverse PLAN.
- Treating a passing `ut-tdd doctor` as proof of behaviour invariance — doctor
  checks structural governance, not observable output correctness.
- Renaming a public CLI flag or a `.ut-tdd/` field without updating callers and
  design docs — this is a breaking API change, not a refactor.
