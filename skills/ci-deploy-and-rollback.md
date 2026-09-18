---
schema_version: skill.v1
name: ci-deploy-and-rollback
skill_type: process
applies_to:
  layers:
    - L7
    - L9
    - L11
    - L12
    - L13
    - L14
  drive_models:
    - Forward
    - Add-feature
    - Recovery
    - Incident
decision_points:
  - when: "A local run is green but the same push fails on CI."
    choose: "Treat it as evidence one of the pre-deploy gate commands was skipped locally."
    over: "Assuming CI is flaky or bypassing with `--no-verify` to unblock the push."
    because: "The skill states a local-green/CI-red split almost always means a gate step was skipped, not that CI is wrong; `--no-verify` must never be used to route around it."
  - when: "Deploying an Add-feature increment that is not yet fully verified end-to-end."
    choose: "Deploy flag-off and enable post-verify."
    over: "Deploying flag-on and verifying in production traffic."
    because: "Flag-off deploys give instant rollback (a config flip) versus a full redeploy/rollback cycle for flag-on changes."
  - when: "A deployed change trips a Sev1 rollback trigger (error rate spike, primary-path non-2xx/3xx, data-integrity failure)."
    choose: "Roll back immediately without waiting for a second opinion."
    over: "Holding the deploy live pending further investigation or a second reviewer."
    because: "The skill states rollback is safer than extended downtime for Sev1 triggers; waiting extends user-facing impact for no added certainty."
  - when: "A deploy requires both a DB migration and an app-code change, and rollback becomes necessary."
    choose: "Run the DB down-migration before reverting app code, then confirm integrity."
    over: "Reverting app code first and migrating the database afterward."
    because: "Reverted app code expecting the old schema against a still-migrated database produces data-integrity failures; migration-before-code-revert keeps schema and code in sync at every step."
  - when: "A schema change is needed (e.g., a column rename or a NOT NULL addition) on a live table."
    choose: "Use a staged expand-contract sequence across multiple deploys."
    over: "Applying the rename or constraint in a single deploy."
    because: "The skill classifies rename/NOT-NULL-add as staged, multi-deploy operations (add -> dual-write -> read-new -> drop-old); doing them in one deploy risks a lock or a window of write failures on live data."
  - when: "A rollback has completed and the system is stable again."
    choose: "Open a Recovery PLAN with root cause, fix classification, and a regression test before considering the incident closed."
    over: "Treating the successful rollback itself as the resolution."
    because: "The skill states a rollback is not a resolution; without the follow-up PLAN and regression test, the same failure can redeploy unnoticed."
---

# ci deploy and rollback

Deploy-gate sequence, rollback criteria, and evidence obligations for harness
releases and for target-repo deploys the harness orchestrates. No deploy starts
without a passing `harness-check`; rollback criteria are defined before deploy,
not after a problem appears.

## When to load this skill

- A PLAN reaches L12 (deploy + acceptance) in the Forward cycle.
- An Add-feature increment is ready to ship behind a flag.
- A Recovery rollback or an Incident hotfix path is needed.

## Pre-deploy gate (mandatory)

All must be green; a failure blocks the deploy.

```
npm run lint          # Biome check (full output — do not pipe to tail)
npm run test          # Vitest
npm run typecheck     # tsc --noEmit
ut-tdd doctor         # harness structural health + plan governance
ut-tdd plan lint      # PLAN schema, steps, dependency existence
ut-tdd review --uncommitted
```

Never bypass with `--no-verify`. A local-green push that fails CI almost always
means one of these was skipped.

## Strategy selection

| Signal | Strategy |
|---|---|
| Forward L12, no data migration | rolling / direct replace, smoke-test immediately |
| Add-feature behind a flag | deploy flag-off, enable post-verify (flag-off = instant rollback) |
| Recovery after regression | revert to last known-good; run DB down-migration if data changed |
| Incident hotfix | minimum-change branch, two-party review, stabilise then merge to main |

## Post-deploy smoke test

1. Health endpoint returns 200.
2. Primary user paths return expected status.
3. `ut-tdd doctor` against the deployed state shows no structural drift.
4. Watch the error rate for ~15 minutes against the pre-deploy baseline.

Record results in `.ut-tdd/audit/`.

## Rollback criteria (defined in the PLAN before deploy)

Typical triggers: error rate above baseline by a set margin, p95 latency
degradation beyond a set threshold, a primary path returning non-2xx/3xx, or a
data-integrity failure. On a Sev1 trigger, roll back without waiting for a second
opinion — rollback is safer than extended downtime.

## Rollback procedure

1. Declare intent (timestamp + reason) in `.ut-tdd/audit/`.
2. Execute: flag-off for a flag-guarded feature; redeploy the previous tagged
   artifact for a rolling deploy; run the DB down-migration *before* reverting
   app code if data changed, then confirm integrity.
3. Re-run the smoke-test sequence against the rolled-back state.
4. Record the final state with `outcome=rollback`.

## After rollback

A rollback is not a resolution. Once stable, open a Recovery PLAN (branch
`hotfix/*`), record the root cause, classify the fix as design-level
(`add-design`) or implementation-only (`add-impl` at L7), and add a regression
test that would have caught the failure before re-deploy. Run `ut-tdd handover`
at the PLAN boundary.

## DB migration safety

- Safe in one deploy: nullable/default column add, concurrent index add, new
  table.
- Staged expand-contract (multi-deploy): column rename (add → dual-write → read
  new → drop old), NOT NULL add (backfill first), large backfill (background
  job, not inline).
- Never in one deploy: type change on live data without a staging run, or a
  table rebuild that takes a lock.

## Completion checklist

- [ ] Pre-deploy gates green (lint / test / typecheck / doctor / plan lint).
- [ ] Strategy + rollback thresholds documented in the PLAN before cutover.
- [ ] Smoke test passes; monitoring window clean.
- [ ] Evidence in `.ut-tdd/audit/`; PLAN advanced via `ut-tdd plan use`.
- [ ] If rolled back: Recovery PLAN opened with root cause + regression test.
