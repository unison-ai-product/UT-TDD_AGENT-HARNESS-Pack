---
schema_version: skill.v1
name: reverse-r4
skill_type: drive-reverse
applies_to:
  layers:
    - L1
    - L3
    - L4
    - L5
  drive_models:
    - Reverse
    - Retrofit
    - Recovery
---

# reverse r4

R4: Gap Register and Forward Routing -- the final Reverse phase. Closes all
gaps, locks `forward_routing`, sets `promotion_strategy`, records
`missing_pair_artifacts`, and merges into the Forward cycle (FR-L1-14,
reverse.md §2, §3 exit conditions, §4).

All 5 reverse types pass through R4 (no skip). The `upgrade` type does not use
RGC after R4.

## When to load this skill

- The `kind=reverse` PLAN has `workflow_phase: R4`.
- R3 intent-hypotheses are complete with PO sign-off.

## Inputs

- `R3-intent-hypotheses.yaml` (all hypotheses classified, PO-reviewed).
- `R2-as-is-design.md` and (if applicable) `R2-as-is-test-design.md`.
- `R1-observed-contracts.yaml` (code, upgrade, fullback types).
- Existing Forward PLAN and gate state from `ut-tdd status` and `ut-tdd doctor`.

## Procedure

1. Finalize `forward_routing` for the cycle. Confirm it is one of the 5 valid
   values: `L1`, `L3`, `L4`, `L5`, or `gap-only`.
   Use the reverse.md §4 routing table:
   - Requirement itself is ambiguous -> `L1` or `L3`.
   - Design judgment missing -> `L4`.
   - Contract/API/DB definition missing -> `L5`.
   - No Forward path available -> `gap-only` (debt/readiness-defer).
2. Set `promotion_strategy`:
   - `new-plan`: a new Forward PLAN at the routing destination must be created.
   - `amend-existing`: an existing Forward PLAN will be updated with the gap.
   - `gap-only-defer`: recorded in debt/readiness-defer with no immediate PLAN.
3. Record `missing_pair_artifacts` for any layer where implementation (design
   artifact) exists but test-design (③) is absent (reverse.md §2.1):
   - List the layer and the missing artifact type.
   - The routing destination must include a test-design PLAN before the
     corresponding pair-freeze gate (G3/G4/G5) can be crossed.
4. For any `conflict` hypothesis from R3: apply `--invalidate-forward` intent
   by marking the relevant gate as needing re-evaluation in the PLAN notes.
   (The `--invalidate-forward` flag is a planned ut-tdd gate mechanism; record
   the gate ID and rationale in the PLAN manually until it is implemented.)
5. For any open gap that cannot be closed now: route to `debt` or
   `readiness-defer` with a new PLAN reference or backlog entry. Do not leave
   gaps unresolved in the gap-register.

## Output artifacts

Write to `.ut-tdd/reverse/<plan_id>/`:

**R4-gap-register.yaml**:
```yaml
plan_id: <PLAN-REVERSE-NN>
forward_routing: <L1|L3|L4|L5|gap-only>
promotion_strategy: <new-plan|amend-existing|gap-only-defer>
missing_pair_artifacts:
  - layer: <L3|L4|L5|L6>
    absent_artifact: <test-design|design-doc>
    routing_gate: <G3|G4|G5>
gaps:
  - hypothesis_id: <H-NN>
    resolution: <new-plan|amend|defer>
    target_plan_or_backlog: ""
invalidated_gates: []     # list gate IDs that need re-evaluation
r4_notes: ""
```

## Exit conditions (reverse.md §3)

Before closing R4 and merging to Forward, ALL of the following must hold:

- [ ] `forward_routing` is set to a valid 5-value enum entry.
- [ ] `promotion_strategy` is set.
- [ ] All hypotheses from R3 have a `resolution` entry in the gap register.
- [ ] `missing_pair_artifacts` is complete: every layer with impl but no
  test-design is listed. If none, the field is an empty list (not omitted).
- [ ] Any `conflict` hypothesis has a named gate marked for re-evaluation.
- [ ] Open gaps with no Forward path are routed to debt/readiness-defer with a
  referenced PLAN or backlog entry.
- [ ] `ut-tdd plan lint` exits 0 with `workflow_phase: R4` and `status: done`
  (or the schema-equivalent closed state).
- [ ] `ut-tdd vmodel lint` exits 0 (no orphan artifacts from the reconstruction).
- [ ] `ut-tdd doctor` exits 0.
- [ ] A new PLAN at the routing destination exists (or the amend target is
  confirmed) if `promotion_strategy` is not `gap-only-defer`.

The Reverse cycle is closed only when all exit conditions are green. The routing
destination's Pair freeze gate (G1/G3/G4/G5) must then be passed before any
downstream L7 work begins on the subject scope.
