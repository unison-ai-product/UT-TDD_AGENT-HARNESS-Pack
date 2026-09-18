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
decision_points:
  - when: "The kind=reverse PLAN has reverse_type=design or reverse_type=normalization"
    choose: "Skip R1 entirely and move directly from R0 to R2"
    over: "Running contract extraction anyway"
    because: "R1 is explicitly skipped for design and normalization types per the reverse type table"
  - when: "A contract is only inferable from its callers, with no explicit schema"
    choose: "Flag it implicit: true and treat it as a high-priority gap candidate"
    over: "Recording it as adequately documented because callers reveal its shape"
    because: "Implicit contracts are exactly the high-priority gaps that R3 must hypothesize about"
  - when: "Contract extraction requires reading a file outside the PLAN's declared scope"
    choose: "Note the scope expansion explicitly in r1_notes"
    over: "Silently reading the extra file without recording the expansion"
    because: "The gate to R2 requires that no contract extraction happened outside declared scope without a note"
  - when: "An observed contract conflicts with an existing design doc"
    choose: "Record the conflict in drift_vs_design for that contract entry"
    over: "Leaving drift_vs_design blank because the design doc still nominally exists"
    because: "R3 needs the drift_vs_design signal to classify the hypothesis as conflict rather than confirmed"
  - when: "Contract extraction is incomplete for an in-scope external surface at the R1-to-R2 boundary"
    choose: "Block the advance to R2"
    over: "Proceeding to R2 with partial contract coverage"
    because: "The R2 gate requires every external surface identified in R0 to have a contract entry"
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
