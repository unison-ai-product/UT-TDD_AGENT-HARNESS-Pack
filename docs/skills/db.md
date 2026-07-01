---
schema_version: skill.v1
name: db
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
    - L7
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
    - Refactor
---

# db

Schema design, state-model design, migration strategy, and the harness.db
projection obligations that accompany any persistent storage change in UT-TDD
(FR-L1-06 harness DB gate_runs / state projection). Apply when a PLAN adds,
modifies, or removes a table, column, index, or migration.

## When to load this skill

- Authoring an L4 basic-design doc that introduces or changes a DB schema.
- A PLAN must extend `harness.db` tables (`plan_registry`, `artifact_registry`,
  `model_runs`, `trace_edges`, `coverage`, `findings`, `gate_runs`).
- A Reverse R1 pass must extract an undocumented schema into a design doc.
- A migration script must be designed before any column/table rename or drop.

## harness.db projection awareness

`.ut-tdd/harness.db` is a SQLite projection DB — it is *written* by
`src/state-db/projection-writer.ts` and *read* by `ut-tdd doctor`, `ut-tdd
vmodel lint`, and `ut-tdd metrics`. It is not an application database; it is
harness state. Rules:

- Never hand-edit `harness.db`; always regenerate via `ut-tdd db rebuild`.
- Any new PLAN that adds harness state must add a row to the appropriate table
  through the projection writer — bare SQL inserts are not authoritative.
- When `ut-tdd doctor` reports a projection mismatch, run `ut-tdd db rebuild`
  and re-run `ut-tdd doctor` before diagnosing further.

## V-model obligations for a schema change

**L3 (functional):** name each entity and its role; state invariants in plain
language ("a `plan_registry` row must always have a non-null `layer`").

**L4 (basic design):** produce an ER diagram (Mermaid `erDiagram`) in the L4 doc.
Each table: columns, types, PK/FK, nullable flags. Include a migration section:
ordered list of DDL changes with reversibility notes.

**L5 (detailed design):** index strategy, query access patterns, constraint
enforcement. If a migration is destructive (DROP COLUMN, data transformation),
document the rollback path explicitly.

**L6 (unit-test design):** cover at least one happy-path insert/update, one
constraint-violation path, and one migration-step idempotency check.

## Migration design rules

- Every schema change ships as a numbered migration file under
  `src/state-db/migrations/` (format: `NNN_<description>.sql`).
- Migrations must be additive first: add columns as nullable before making them
  required; add tables before dropping old ones.
- Destructive migrations require a PLAN `review_evidence` entry confirming the
  data loss is intentional and approved.
- `ut-tdd doctor` must exit 0 after migration files are added — governance checks
  that migration ordering is monotonic and no gaps exist.

## Pair-freeze checklist for a schema PLAN

- [ ] L4 doc with ER diagram exists at `docs/design/.../L4-basic/`.
- [ ] Migration section in the L4 doc lists each DDL step in order.
- [ ] Migration file(s) exist under `src/state-db/migrations/` and are numbered
      without gaps.
- [ ] L6 unit-test design covers constraint violations and migration idempotency.
- [ ] `ut-tdd plan lint` exits 0.
- [ ] `ut-tdd doctor` exits 0.
- [ ] For harness.db changes: `ut-tdd db rebuild` succeeds and projection-writer
      tests are green (`bun run test`).
