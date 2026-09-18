---
schema_version: skill.v1
name: deprecation-cutover
skill_type: process
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
    - L7
    - L11
    - L12
  drive_models:
    - Refactor
    - Retrofit
    - Recovery
    - Reverse
decision_points:
  - when: "Considering deprecating a command, module, or convention"
    choose: "Confirm a working replacement already exists in src/ and docs/ before raising the PLAN"
    over: "Deprecating first and building the replacement afterward"
    because: "The decision checklist states never deprecate without a landed replacement"
  - when: "Deciding whether a cutover is complete"
    choose: "Treat zero remaining references (grep -r across docs/ src/ tests/) as the exit condition"
    over: "Considering the cutover done once the new path is default, while old references still exist"
    because: "The checklist defines zero references as the explicit cutover exit condition"
  - when: "A PLAN touches env handling in src/cli.ts and finds a residual legacy-prefixed env name"
    choose: "Migrate it to UT_TDD_* in the same PLAN, or record an explicit improvement-backlog.md entry if deferring"
    over: "Leaving the legacy-prefixed name untouched with no record"
    because: "The naming contract requires migration in the same PLAN or an explicit backlog entry — silent deferral is not allowed"
  - when: "Advancing a strangler-fig phase for a harness-internal cutover"
    choose: "Advance one phase per commit only after that boundary has harness-check-green evidence recorded in .ut-tdd/audit/"
    over: "Advancing multiple phases in one commit or advancing without evidence"
    because: "Phasing requires advancing one phase per commit, each boundary carrying harness-check-green evidence"
  - when: "A cutover PLAN removes an implementation that was never back-filled to a design doc"
    choose: "Open a Reverse PLAN (R0-R4) to record what was removed and why before marking the cutover PLAN accepted"
    over: "Marking the cutover PLAN accepted and leaving the Reverse back-fill for later"
    because: "The descent-obligation contract requires every removed feature to leave a design artifact behind; the PLAN must not be accepted while that obligation is open"
---

# deprecation cutover

Discipline for removing or replacing a command, module, path, env name, or
convention in the UT-TDD harness while keeping V-model traceability and
`harness-check` green. Apply when a PLAN deletes or supersedes existing runtime
surface.

## When to load this skill

- A PLAN removes or replaces a `ut-tdd` subcommand, `src/` module, agent, skill
  pack, or environment variable.
- Drive is Retrofit (incremental strangler-fig replacement), Refactor
  (consolidation), or Reverse (back-fill after a cutover).
- `ut-tdd doctor` reports an `asset-drift` finding for legacy runtime residue.

## Decision checklist (before raising the PLAN)

1. Does a working replacement already exist in `src/` and `docs/`? Never
   deprecate without a landed replacement.
2. How many references remain? Run `grep -r "<target>" docs/ src/ tests/`. Zero
   references is the cutover exit condition.
3. Is the target named with a legacy runtime prefix or a legacy vendor path?
   The `asset-drift` gate in `ut-tdd doctor` fails on legacy runtime
   command/name/env residue and legacy source paths in enrolled agent, skill,
   and prompt assets (FR-L1-49). Removing it is required, not optional.
4. What is the rollback path if the replacement is broken post-cutover?

## UT-TDD naming contract

New env names and commands use the `UT_TDD_*` prefix (correct example:
`UT_TDD_ALLOW_RAW_AGENT`). A PLAN that touches env handling in `src/cli.ts` must
migrate any residual legacy-prefixed names to `UT_TDD_*` in the same PLAN or
record an explicit `improvement-backlog.md` entry if deferring.

## Strangler-fig phasing for harness internals

```
Phase 0  old path live; new path exists behind a UT_TDD_* opt-in flag
Phase 1  new path default; old path warn-deprecated (logged)
Phase 2  old path removed; the asset-drift finding within `ut-tdd doctor` is green
Phase 3  deprecation notices / compat shims removed
```

Record the current phase in PLAN `status` and the design doc. Advance one phase
per commit; each boundary carries a `harness-check`-green evidence record in
`.ut-tdd/audit/`.

## Removal checklist (L7)

- [ ] `grep -r "<deprecated-identifier>" docs/ src/ tests/` returns zero hits.
- [ ] `ut-tdd doctor` passes with zero `asset-drift` findings.
- [ ] `npm run typecheck` passes — no dangling type references.
- [ ] Tests referencing the removed path are updated or removed with a
      rationale comment (no silent `.skip`).
- [ ] `ut-tdd review --uncommitted` evidence recorded before merge.

## Reverse back-fill obligation

If a cutover removes an impl that was never back-filled to design, open a Reverse
PLAN (R0→R4, tracked by `kind=reverse`, validated by `ut-tdd plan lint` and
`ut-tdd vmodel lint`) to record what was removed and why. Do not mark a cutover
PLAN `accepted` while a Reverse obligation is open — the descent-obligation
contract requires every removed feature to leave a design artifact behind.
