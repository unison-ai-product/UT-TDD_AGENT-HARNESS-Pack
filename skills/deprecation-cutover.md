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
Phase 2  old path removed; ut-tdd doctor asset-drift is green
Phase 3  deprecation notices / compat shims removed
```

Record the current phase in PLAN `status` and the design doc. Advance one phase
per commit; each boundary carries a `harness-check`-green evidence record in
`.ut-tdd/audit/`.

## Removal checklist (L7)

- [ ] `grep -r "<deprecated-identifier>" docs/ src/ tests/` returns zero hits.
- [ ] `ut-tdd doctor` passes with zero `asset-drift` findings.
- [ ] `bun run typecheck` passes — no dangling type references.
- [ ] Tests referencing the removed path are updated or removed with a
      rationale comment (no silent `.skip`).
- [ ] `ut-tdd review --uncommitted` evidence recorded before merge.

## Reverse back-fill obligation

If a cutover removes an impl that was never back-filled to design, open a Reverse
PLAN (R0→R4, tracked by `kind=reverse`, validated by `ut-tdd plan lint` and
`ut-tdd vmodel lint`) to record what was removed and why. Do not mark a cutover
PLAN `accepted` while a Reverse obligation is open — the descent-obligation
contract requires every removed feature to leave a design artifact behind.
