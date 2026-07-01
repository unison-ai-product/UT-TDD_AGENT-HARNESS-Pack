---
schema_version: skill.v1
name: harness-observability
skill_type: verification
applies_to:
  layers:
    - L5
    - L6
    - L7
    - L8
    - L11
    - L12
    - L13
    - L14
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Recovery
---

# harness observability

Design and operation of `harness.db` projections, session logs, and
cross-runtime token/cost telemetry — the observability backbone of UT-TDD
(FR-L1-06 state SSoT, FR-L1-07 auto-registration, FR-L1-20 metrics, FR-L1-38
model/cost). Apply when adding a projection, a `ut-tdd doctor` check that reads
the DB, or a telemetry capture point.

## When to load this skill

- A PLAN adds or changes a `harness.db` table, a `gate_runs` / `model_runs`
  capture, or a metric.
- A doctor check needs to read DB state and fail-close on a missing row.
- Cost/token telemetry must be recorded for an agent call.

## What harness.db is (and is not)

`harness.db` is a **deterministic projection** rebuilt from `docs/plans/*.md`,
`.ut-tdd/` state, and session logs via `src/state-db/projection-writer.ts`.
Never write to it directly; never treat it as the source of design truth (that
lives in `docs/design/`). It is authoritative for: PLAN trace coverage, whether
a gate ran (`gate_runs`), model/cost per run (`model_runs`), and skill adoption
(`skill_evaluations`). Rebuild with `ut-tdd db rebuild`; inspect with
`ut-tdd metrics`, `ut-tdd telemetry`, and `ut-tdd find`.

## Adding a new projection (L5→L7)

1. Design the table at L5 in the feature design doc — name, columns, types, and
   the question it answers.
2. Write L6 test design for the projection: seed input state → run projection →
   assert rows (`tests/projection-writer.test.ts` is the pattern).
3. Implement in `src/state-db/projection-writer.ts`.
4. Wire it into `ut-tdd doctor` so a missing/empty projection is a fail-close
   condition, not a silent gap (`db-projection-coverage` / `-ingestion`).

## Model / cost telemetry (FR-L1-38)

Token and cost telemetry is exposed by `ut-tdd telemetry` and projected into
`model_runs`. When adding an agent call path:

- [ ] Route the call through `ut-tdd claude` / `ut-tdd codex` / `ut-tdd team
      run`, not a raw provider spawn — only the wrappers capture lifecycle and
      cost evidence.
- [ ] Record the run metadata (runtime, model, role, drive, plan_id, timings)
      in `model_runs`.
- [ ] Store metadata only — never prompt text, response text, credentials, or
      PII.

## Session log and handover

The `SessionStart` and `Stop` hooks bracket each session
(`src/runtime/session-log.ts`) and compress events into a PLAN digest. At a
session boundary run `ut-tdd handover` to flush
`.ut-tdd/handover/CURRENT.json`. Treat the handover carry as a claim, not truth:
verify it against `git log` and `ut-tdd doctor` before relying on it.

## Redaction boundary

The observability layer must never store API keys, tokens, credentials, PII, or
verbatim prompt/response text. If a capture point could include these, add a
redaction step before the `projection-writer.ts` insert and a unit test
asserting the field is absent.

## L8 integration test for an observability gate

- [ ] Projection writes the correct row given valid input state.
- [ ] Doctor gate passes when the row is present.
- [ ] Doctor gate fails when the row is absent (absence-blindness prevention).
- [ ] Rebuild from scratch produces identical rows (determinism).

Capture `ut-tdd status` + `ut-tdd doctor` output into `.ut-tdd/audit/` as the
canonical acceptance evidence — DB query output alone is not acceptance proof.
