---
schema_version: skill.v1
name: data-migration
skill_type: process
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
    - L8
    - L11
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Retrofit
    - Recovery
---

# data migration

ETL integrity, strangler-fig cutover, and rollback discipline for data and
schema migrations inside the V-model Forward cycle. Apply when a PLAN adds,
replaces, or removes a data store, schema, or external system interface
(supports FR-L1-44 onboarding import).

## When to load this skill

- A PLAN changes a schema, data store, or external IF contract.
- Drive is Retrofit (incremental replacement) or Recovery (incident-driven
  cutover).

## Design-phase obligations (L4–L5)

Before pair-freeze, the design doc under `docs/design/` must contain four
sections: **before** (current shape), **after** (target shape), **transform
rules** (field-level mapping, each independently testable), and **rollback**
(exact reversal steps + the signal that triggers them). Pair-freeze is blocked
until the design doc exists and is linked as `parent_design` in the PLAN.

## Strangler-fig phasing (recorded at L5)

```
Phase 0  reads old / writes old        baseline verified
Phase 1  reads old / writes both       new store accumulates
Phase 2  reads new / writes both       new store validated under read load
Phase 3  reads new / writes new        old store idle
Phase 4  old store removed             zero consumers confirmed
```

Each boundary requires a passing verification step (count, checksum, or
integration test) before the next phase. Document the method at L5 so L6 test
design can pair against it.

## Integrity verification (L6 test design)

- [ ] Record count: source count = target count (fail-close).
- [ ] Sample spot-check: representative rows match field-for-field.
- [ ] Zero null/constraint violations after transform.
- [ ] Up script succeeds on a clean target.
- [ ] Rollback script restores the pre-migration state (bidirectional test).

Record the test design under `docs/test-design/` paired with the L5 doc;
`ut-tdd doctor` flags a migration PLAN with no test-design trace.

## L7 implementation rules

- [ ] Migration code is TypeScript/Bun — no ad-hoc shell/Python that escapes
      harness traceability.
- [ ] Idempotent: re-running on an already-migrated target is safe.
- [ ] Explicit error handling: on a row failure, log the row id and continue to
      a summary; never silently skip.
- [ ] Credential rotation is out of scope — escalate to PO if the migration
      needs auth changes (a harness escalation boundary).
- Run `ut-tdd review --uncommitted` afterward; the evidence must include a
  passing integrity run recorded in `.ut-tdd/audit/`.

## Rollback decision gate

Define a measurable trigger at L5 (integrity-check failure, post-cutover error
rate over threshold, or an explicit operator decision from a `ut-tdd doctor`
gate-run failure). Do not roll back on subjective discomfort, and do not deploy
the migration before the trigger criterion is recorded.

## FR-L1-44 onboarding note

When migrating to onboard an existing project: run `ut-tdd setup` to initialise
`.ut-tdd/`, baseline existing PLANs via `ut-tdd status`, and treat the import as
a Phase 0 migration — verify `harness.db` asset counts match the file-system
count before starting new work.
