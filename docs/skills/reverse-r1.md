---
schema_version: skill.v1
name: reverse-r1
skill_type: drive-reverse
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Reverse
    - Retrofit
---

# reverse r1

R1: Observed Contracts -- extract and document observable API, DB, type, and
compatibility contracts from the subject scope (FR-L1-14, reverse.md §2).

R1 applies to reverse types `code`, `upgrade`, and `fullback`.
It is SKIPPED for `design` and `normalization` types -- those go directly from
R0 to R2.

## When to load this skill

- The `kind=reverse` PLAN has `workflow_phase: R1`.
- The `reverse_type` is `code`, `upgrade`, or `fullback`.

## Inputs

- `R0-evidence-map.yaml` from the completed R0 phase.
- Source files, type definitions, OpenAPI/schema files, DB migration files, and
  any integration test fixtures that reveal contract surface.

## Procedure

1. For each external-facing interface in scope (HTTP endpoints, exported
   functions, DB tables, event schemas), extract the observable contract:
   - Input types and validation rules.
   - Output types and error codes.
   - Side effects (DB writes, event publishes, file mutations).
2. Identify compatibility constraints: which callers depend on the current
   contract shape, and what would break on a change.
3. Note any contracts that are implicit (inferred from callers only, no
   explicit schema) -- these are high-priority gaps for R3.
4. Cross-reference with `R0-evidence-map.yaml` drift signals: confirm whether
   observed contracts match or conflict with any existing design docs.

## Output artifact: observed-contracts

Write to `.ut-tdd/reverse/<plan_id>/R1-observed-contracts.yaml`:

```yaml
plan_id: <PLAN-REVERSE-NN>
contracts:
  - id: <unique short id>
    surface: <http|db|event|type|function>
    description: ""
    input_types: []
    output_types: []
    callers: []          # known dependents
    schema_source: <path or null>
    implicit: <true|false>
    drift_vs_design: ""  # blank if no design doc exists
implicit_contract_count: 0
r1_notes: ""
```

## Gate to R2

Before advancing `workflow_phase` to `R2`, verify:

- [ ] Every external surface identified in R0 has a contract entry.
- [ ] `implicit_contract_count` is accurate; implicit contracts are flagged
  (they will become gap candidates in R3).
- [ ] No contract extraction required reading files outside the declared scope
  without noting the expansion in `r1_notes`.
- [ ] `ut-tdd plan lint` exits 0 with `workflow_phase: R2`.
- [ ] `ut-tdd doctor` exits 0.

Do not proceed to R2 if contract extraction is incomplete for in-scope surfaces.
