---
schema_version: skill.v1
name: reverse-analysis
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
decision_points:
  - when: "Implementation exists in the codebase but no design doc or contract documentation exists for it"
    choose: "Classify the cycle as reverse_type=code (R1 not skipped)"
    over: "Classifying it as reverse_type=design (R1 skipped)"
    because: "Without observed contracts, R1 contract extraction is required before R2 as-is design can be trusted"
  - when: "Only naming/structure drift is observed and there is no contract gap"
    choose: "Classify the cycle as reverse_type=normalization (R1 skipped)"
    over: "Classifying it as reverse_type=code and running full contract extraction"
    because: "Normalization drift does not change observable contracts, so R1 work would be redundant"
  - when: "A Scrum increment completes and needs to be promoted to V-model artifacts"
    choose: "Classify the cycle as reverse_type=fullback and route through R0-R4"
    over: "Starting a fresh Forward PLAN without a Reverse evidence trail"
    because: "fullback is the type designed to promote Discovery/Scrum closure into formally anchored Forward artifacts"
  - when: "A dependency version bump has unknown downstream impact"
    choose: "Classify the cycle as reverse_type=upgrade (R1 not skipped, RGC not used)"
    over: "Classifying it as reverse_type=normalization"
    because: "Upgrade impact assessment requires observed compatibility contracts from R1; normalization assumes no contract gap"
  - when: "R4 routing has just been decided for a Reverse cycle"
    choose: "Require the routing destination's Pair freeze gate (G1/G3/G4/G5) to pass before starting L7 work"
    over: "Starting downstream implementation immediately after R4 completes"
    because: "ut-tdd vmodel lint will surface missing pair artifacts if implementation starts before the gate is crossed"
  - when: "R0 found has_existing_tests=false for the subject scope"
    choose: "Record missing_pair_artifacts at R4 and require a test-design PLAN at the routing destination before G3/G4/G5"
    over: "Having Reverse itself generate the missing test code"
    because: "Reverse only observes and records the test-design state; it does not generate test code"
---

# reverse analysis

Entry skill for the UT-TDD Reverse drive (FR-L1-14). Load this skill when you
need to decide whether to start a Reverse cycle, which type to use, and how
the R0-R4 phases connect to Forward.

## When to load this skill

- A drift signal fires (schema/contract divergence detected by `ut-tdd doctor`).
- Existing code or design is not traceable to any Forward L0-L14 artifact.
- A Scrum increment completes and must be promoted to V-model artifacts (fullback).
- A Discovery cycle ends and its conclusions need formal Forward anchoring.
- A Retrofit impact assessment requires tracing unknown dependencies (upgrade type).

## The 5 Reverse types (FR-L1-14 / reverse.md §3.3)

| type | when | R1 skip? | typical forward_routing |
|---|---|---|---|
| `code` | impl exists, no design/contracts | no | L3, L4, or L5 |
| `design` | design doc exists, impl unknown or out-of-sync | yes | L4 or L5 |
| `upgrade` | dependency version bump, impact unknown | no | L5 (RGC not used) |
| `normalization` | naming/structure drift, no contract gap | yes | L3 or L4 |
| `fullback` | Discovery/Scrum closure, promote to V-model | no | L1, L3, or L4 |

## R0-R4 phase map

```
R0  Evidence Acquisition   -- what exists; has_existing_tests flag
R1  Observed Contracts      -- API/DB/type contracts (skip: design, normalization)
R2  As-Is Design            -- current design + DAG; test-design if tests exist
R3  Intent Hypotheses       -- gap/routing candidates; PO verification required
R4  Gap & Routing           -- gap-register + forward_routing + promotion_strategy
     |
     +-- Forward merge at R4: routing value is one of L1/L3/L4/L5/gap-only
```

After R4, the routing destination's Pair freeze gate (G1/G3/G4/G5) must be
passed before any downstream L7 work begins. `ut-tdd vmodel lint` will surface
missing pair artifacts.

## PLAN frontmatter for a Reverse cycle

```yaml
kind: reverse
drive: <be|fe|fullstack|db|agent>   # specialist for the subject work
layer: cross
workflow_phase: R0                  # update as phases advance
reverse_type: <code|design|upgrade|normalization|fullback>
```

Validate with `ut-tdd plan lint` (schema) and `ut-tdd doctor` (governance) at
every phase boundary.

## Test-design symmetry rule (reverse.md §2.1)

Reverse is responsible for the V-model test-design pairing state:

- Tests exist (`has_existing_tests=true`): R2 reconstructs `as-is-test-design`.
- Tests absent: R4 records `missing_pair_artifacts`; routing destination must
  include a test-design PLAN before G3/G4/G5 gate can be crossed.

Reverse itself does not generate test code. It observes and records the
test-design state so Forward can freeze the pair correctly.

## Checklist before starting R0

- [ ] Identify the reverse_type from the table above.
- [ ] Confirm `ut-tdd status` shows no blocking handover or open doctor violation.
- [ ] Create a `kind=reverse` PLAN in `docs/plans/` with correct frontmatter.
- [ ] Run `ut-tdd plan lint` -- exits 0 before proceeding.
