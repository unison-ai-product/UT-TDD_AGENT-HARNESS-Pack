---
schema_version: skill.v1
name: error-fix
skill_type: process
applies_to:
  layers:
    - L4
    - L6
    - L7
    - L8
  drive_models:
    - Recovery
    - Incident
    - Forward
    - Add-feature
    - Reverse
decision_points:
  - when: "A defect is confirmed and about to be fixed"
    choose: "write a failing regression test that reproduces the exact error on current HEAD before touching source"
    over: "editing source first and adding a test afterward"
    because: "a fix without a prior-failing test cannot be verified to address the actual defect, and the harness treats fix-without-test as an incomplete unit of work"
  - when: "Source code contradicts its own L5 spec"
    choose: "update the L5 doc first, then fix the source to match"
    over: "fixing the source directly and leaving the spec as-is"
    because: "fixing source against an unchanged spec creates a descent gap that `ut-tdd doctor` may not detect"
  - when: "While fixing a defect, adjacent code looks like it could use cleanup"
    choose: "leave adjacent code untouched and file cleanup as separate scope"
    over: "refactoring the adjacent code in the same commit as the fix"
    because: "scope creep in a fix commit makes regression bisection harder and makes the commit harder to revert if it introduces a secondary defect"
  - when: "A type error surfaces while investigating the defect"
    choose: "treat the type error as evidence and fix the underlying cause"
    over: "adding `// @ts-ignore` to silence it and move on"
    because: "the type error is the signal that exposed the defect; silencing it hides future regressions of the same class"
  - when: "Closing a Recovery or Incident PLAN"
    choose: "document the prevention measure (new doctor gate, lint rule, or design doc update) before closing"
    over: "closing once the regression test and fix are both green"
    because: "the forced-stop Recovery policy requires re-occurrence prevention as an exit contract, not just a resolved symptom"
---

# error fix

Applying a targeted fix to a confirmed defect under Recovery or Incident drive.
A fix is not complete until a regression test that would have caught the
original error is Green and committed. Fixes made without regression tests
repeat — the harness treats a fix-without-test as an incomplete unit of work.

## When to load this skill

- A `ut-tdd doctor` check, CI failure, or runtime error has been confirmed as
  a defect (not a flaky environment issue).
- A Recovery or Incident PLAN is open and the root cause has been identified.
- A Forward or Add-feature PLAN discovers a defect in adjacent code during
  implementation — the fix must be scoped and committed separately.

## Fix protocol

### 1. Reproduce before touching source

Write a failing test that reproduces the error before changing any source. This
is the Red step for a fix — it confirms the defect is real and gives the
regression fence.

```
npm run test tests/<affected>.test.ts
```

The test must fail on the current HEAD with the exact error being fixed. Commit
the failing test with a message like `test(module): add regression for <error>`.

### 2. Scope the fix

Read the L5 design doc (if one exists for the module) and identify whether the
error is:

- A **logic error** inside the function boundary — fix in source only.
- A **contract violation** — the function is doing what the spec says but the
  spec is wrong; update the L5 doc first, then fix source.
- A **missing guard** — an input case the spec did not cover; add the case to
  L5 and L6 before fixing source.

Do not fix source that contradicts its spec without updating the spec — this
creates a descent gap that `ut-tdd doctor` may not detect.

### 3. Apply the minimal fix

Change only the lines required to make the regression test Green. Do not clean
up adjacent code or refactor in the same commit — scope creep makes the fix
harder to review and harder to revert if it introduces a secondary defect.

Run the full gate sequence:

```
npm run typecheck && npm run lint && npm run test && ut-tdd doctor
```

All gates must be Green before committing the fix.

### 4. Record evidence

- Commit the fix with a `fix(module): description` message referencing the
  PLAN or audit entry.
- Update the PLAN `review_evidence` field with the regression-test SHA and the
  fix SHA.
- If the fix touches a public API or `.ut-tdd/` state structure, run
  `ut-tdd review --uncommitted` before closing the PLAN.

## Recovery / Incident exit conditions

A fix PLAN under Recovery or Incident is closed only when:

- [ ] Regression test is Green and committed before the fix commit.
- [ ] `npm run typecheck && npm run lint && npm run test && ut-tdd doctor`
  all green on the fix HEAD.
- [ ] Root cause documented in the PLAN or `.ut-tdd/audit/` entry (what
  allowed the defect to exist, not just what the defect was).
- [ ] Prevention measure identified: either a new `ut-tdd doctor` gate, a
  lint rule, or a design doc update that would have caught this earlier.
- [ ] `ut-tdd review --uncommitted` no blocking findings.
- [ ] Handover updated or closed (`ut-tdd handover`).

## Anti-patterns

- Fixing source without a reproduction test — the fix cannot be verified to
  actually address the defect, and the same defect can silently re-enter.
- Including a refactor in the fix commit — this makes regression bisection
  harder and conflates two different kinds of change.
- Closing a Recovery PLAN without documenting the prevention measure — the
  harness requires re-occurrence prevention as an exit contract (forced-stop
  Recovery policy).
- Using `// @ts-ignore` to silence a type error that surfaced the defect —
  the type error is evidence; silencing it hides future regressions.
