---
schema_version: skill.v1
name: reverse-r2
skill_type: drive-reverse
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Reverse
    - Retrofit
    - Recovery
---

# reverse r2

R2: As-Is Design -- reconstruct the current design, dependency graph, and
impact model from observed evidence (FR-L1-14, reverse.md §2). Includes
test-design reconstruction when tests exist (reverse.md §2.1).

All 5 reverse types pass through R2 (no skip).

## When to load this skill

- The `kind=reverse` PLAN has `workflow_phase: R2`.

## Inputs

- `R0-evidence-map.yaml` (all types).
- `R1-observed-contracts.yaml` (code, upgrade, fullback types); not present for
  design/normalization types.
- Source files, existing design docs, ADRs, and any prior test files listed in
  the evidence map.

## Procedure

1. Reconstruct the module/component structure: name each unit, its
   responsibility, and its dependencies.
2. Build a DAG (dependency graph) for the subject scope:
   - nodes = modules / services / DB tables / event topics.
   - edges = imports, HTTP calls, DB reads/writes, event pub/sub.
3. Assess change impact: for each node, which callers or dependents would be
   affected by a change in its contract or behavior.
4. If `has_existing_tests=true` (from R0):
   - Map each test file to the module it covers.
   - Reconstruct the observable test-design: what scenarios are covered, what
     assertions are made, what is absent.
   - Write this as `as-is-test-design` -- it becomes the Forward routing
     destination's starting material for the pair freeze gate.
5. Note structural gaps: modules with no design doc, contracts with no test
   coverage, DAG edges with no explicit interface definition.

## Output artifacts

Write to `.ut-tdd/reverse/<plan_id>/`:

**R2-as-is-design.md** -- human-readable design reconstruction:
- Module list with responsibilities.
- DAG in text/mermaid form.
- Impact assessment table (node -> affected callers).
- Structural gap list.

**R2-as-is-test-design.md** (only when `has_existing_tests=true`):
- Test file inventory with covered module and scenario summary.
- Observed assertion patterns.
- Known coverage gaps within existing tests.

## Gate to R3

Before advancing `workflow_phase` to `R3`, verify:

- [ ] `R2-as-is-design.md` exists and the DAG is navigable (no orphaned nodes).
- [ ] If `has_existing_tests=true`: `R2-as-is-test-design.md` exists and maps
  every test file to at least one module node.
- [ ] If `has_existing_tests=false`: a note is recorded in `R2-as-is-design.md`
  confirming test absence (feeds `missing_pair_artifacts` in R4).
- [ ] Structural gaps are listed (not resolved -- resolution is R3/R4).
- [ ] `ut-tdd plan lint` exits 0 with `workflow_phase: R3`.
- [ ] `ut-tdd vmodel lint` exits 0 (no new orphan artifacts from reconstruction
  work).
- [ ] `ut-tdd doctor` exits 0.

The DAG and impact assessment must be complete enough for R3 hypothesis work.
Incomplete DAGs that omit known dependencies are a blocking gap.
