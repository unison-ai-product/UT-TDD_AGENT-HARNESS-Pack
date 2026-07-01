---
schema_version: skill.v1
name: reverse-rgc
skill_type: drive-reverse
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Reverse
    - Recovery
---

# reverse rgc

RGC: Reverse Gate Criteria -- the closure gate that confirms a Reverse cycle is
complete and its outputs satisfy the V-model obligations before the subject
scope re-enters Forward (FR-L1-14, reverse.md §3 exit conditions, §4 Forward
merge rules).

The `upgrade` reverse type does not use RGC. All other types (`code`, `design`,
`normalization`, `fullback`) must pass RGC before the Reverse PLAN can be
closed.

## When to load this skill

- R4 is complete and the `forward_routing` value is confirmed.
- The Reverse PLAN is about to transition to `status: done`.
- A handover is being written at the end of a Reverse cycle.

## RGC checklist (all items required)

### R-phase artifact completeness

- [ ] `R0-evidence-map.yaml` exists; `has_existing_tests` is set explicitly.
- [ ] `R1-observed-contracts.yaml` exists (code/upgrade/fullback types only;
  skip-check: absent for design/normalization is correct).
- [ ] `R2-as-is-design.md` exists; DAG is present and navigable.
- [ ] `R2-as-is-test-design.md` exists IF `has_existing_tests=true`.
- [ ] `R3-intent-hypotheses.yaml` exists; `po_reviewed: true` is set.
- [ ] `R4-gap-register.yaml` exists; `forward_routing` and `promotion_strategy`
  are set; all H-NN hypotheses have resolutions.

### V-model test-design state (reverse.md §2.1)

- [ ] If `has_existing_tests=true`: `as-is-test-design` reconstruction is
  complete and will be handed to the routing-destination pair freeze gate.
- [ ] If `has_existing_tests=false`: `missing_pair_artifacts` in the gap
  register names every layer with a design artifact but no test-design. These
  layers cannot reach L7 implementation until a test-design PLAN is created and
  the corresponding pair-freeze gate (G3/G4/G5) is passed.

### Forward merge readiness

- [ ] `forward_routing` is one of: `L1`, `L3`, `L4`, `L5`, `gap-only`.
- [ ] Routing destination PLAN exists (or `gap-only-defer` is documented in
  debt/readiness-defer with a backlog reference).
- [ ] Any invalidated Forward gates are named in `R4-gap-register.yaml`
  `invalidated_gates` list.
- [ ] No open gap is silently dropped: each unresolved item is deferred to debt
  or a new PLAN.

### Machine validation

- [ ] `ut-tdd plan lint` exits 0 on the Reverse PLAN.
- [ ] `ut-tdd vmodel lint` exits 0 (orphan count unchanged or reduced vs. R0
  baseline).
- [ ] `ut-tdd doctor` exits 0.
- [ ] `ut-tdd review --uncommitted` produces no blocking findings against the
  Reverse phase artifacts.

### Handover

- [ ] `.ut-tdd/handover/CURRENT.json` is updated to reflect Reverse closure and
  the routing destination PLAN as the next active task.

## What RGC does NOT check

RGC does not verify that the routing destination's pair-freeze gate has been
passed -- that is a Forward-cycle obligation. RGC only confirms that Reverse
has provided all required inputs (R-phase artifacts, test-design state,
gap-register) for Forward to do so.

## After RGC passes

Set PLAN `status: done`. The subject scope now belongs to the routing
destination's Forward PLAN. The routing destination's Pair freeze gate
(G1/G3/G4/G5) is the next blocking boundary before any L7 work begins.
