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
decision_points:
  - when: "A migration PLAN reaches pair-freeze but the design doc is missing one of before/after/transform-rules/rollback"
    choose: "Block pair-freeze until all four sections exist"
    over: "Allowing pair-freeze with a partial design doc and filling gaps during implementation"
    because: "Pair-freeze is explicitly blocked until the design doc exists and is linked as parent_design; retrofitting sections after freeze breaks V-model traceability"
  - when: "Deciding when to trigger rollback during a strangler-fig cutover"
    choose: "Define a measurable trigger at L5 (integrity-check failure, error-rate threshold, or explicit operator decision) before deploying"
    over: "Rolling back based on subjective discomfort or ad-hoc judgement after deployment"
    because: "The rollback decision gate explicitly forbids subjective triggers and requires the criterion recorded before deploy"
  - when: "A migration touches auth or credential handling"
    choose: "Escalate to PO"
    over: "Implementing credential rotation as part of the migration PLAN"
    because: "Credential rotation is explicitly out of scope and named a harness escalation boundary"
  - when: "A row fails during the migration run"
    choose: "Log the row id and continue to a summary"
    over: "Silently skipping the row or aborting the whole run"
    because: "L7 implementation rules require explicit error handling and forbid silent skips"
  - when: "Advancing a strangler-fig phase (0-4)"
    choose: "Pass the phase's verification step (count/checksum/integration test) before moving to the next phase"
    over: "Advancing phases on a schedule regardless of verification"
    because: "Each boundary requires a passing verification step before the next phase per the phasing table"
  - when: "Onboarding an existing project (FR-L1-44) into UT-TDD"
    choose: "Treat the import as a Phase 0 migration and verify harness.db asset counts against the file-system count before new work"
    over: "Running ut-tdd setup and immediately starting new PLANs without a baseline check"
    because: "The onboarding note requires baselining via ut-tdd status and verifying asset counts match before starting new work"
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

- [ ] Migration code uses the TypeScript/Node project toolchain — no ad-hoc shell/Python that escapes
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
