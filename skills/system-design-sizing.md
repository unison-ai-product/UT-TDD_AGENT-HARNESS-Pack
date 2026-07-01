---
schema_version: skill.v1
name: system-design-sizing
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
    - L4
  drive_models:
    - Forward
    - Discovery
    - Scrum
    - Add-feature
---

# system design sizing

Two-stage system design and capacity/complexity sizing in UT-TDD (FR-L1-28
two-stage agent design, W-model). Apply when a PLAN must scope a new system
component, estimate structural complexity at L4, or determine whether a feature
requires a single V-pass or the full W-model two-stage treatment.

## When to load this skill

- An L1 requirements PLAN must decide whether the target system is a general
  system (single V) or an agent system requiring the two-stage W-model.
- An L3 functional design must bound the scope of a feature before L4 detailed
  sizing.
- An L4 basic-design doc must record an explicit sizing decision (module count,
  state surface, expected data volume) before pair-freeze.
- A Discovery Scrum S1 plan step must define the design stage entry point.

## Two-stage design (W-model) trigger

The W-model (UT-TDD W) applies when the target system includes an AI agent
layer. It runs the V-model twice:

- **Phase 1 (general system V):** design and verify the outer system as if agents
  were not involved (L0-L9 standard V). Output: L9 system-test design.
- **Phase 2 (agent system V):** using Phase 1 output as the foundation, design
  the agent orchestration, guardrails, and merge surface (L10 agent-merge).

For harness-internal development (no outward-facing agent layer), a single V is
correct. Do not apply the W-model to harness self-development.

## L4 sizing checklist

At L4 basic design, record a sizing section with:

- **Module count:** how many new `src/` modules does this PLAN introduce?
- **State surface:** does this PLAN add harness.db tables, `.ut-tdd/` YAML keys,
  or CLI state? (If yes, load `db.md` skill.)
- **External dependencies:** does this PLAN cross a process boundary (network,
  subprocess, file I/O beyond `.ut-tdd/`)? List each.
- **Test complexity estimate:** number of distinct behaviour paths the L6 unit-
  test design must cover.
- **PLAN split decision:** if the sizing result implies more than one PLAN
  boundary (different `layer` or `drive`), split now rather than at trace-freeze.

## Scoping rules

- A PLAN that spans more than one V-model layer pair (e.g., L4 design + L7
  implementation in one PLAN) must justify the grouping in the PLAN `summary`
  field. The default is one PLAN per layer-pair crossing.
- Complexity that exceeds a two-sprint estimate at L4 is a signal to split the
  PLAN and re-size each child. Record the split rationale in the L4 doc.
- Size is not a metric to optimise — it is a gate input. A small PLAN that is
  structurally complete is correct; a large PLAN that is vague is a governance
  violation.

## Discovery drive sizing

In Scrum S1 (plan) under Discovery drive, produce a lightweight sizing memo in
the PLAN `summary` rather than a full L4 doc. The memo must state:
- Which V-model entry layer applies (L1/L3/L4).
- Whether Phase 2 (W-model) is triggered.
- The top-three unknowns that the S2 PoC must resolve.

Promote the memo to a proper design doc before S3 verify.

## Pair-freeze checklist

- [ ] L4 doc contains a `## Sizing` section with module count, state surface,
      external dependencies, and PLAN-split decision.
- [ ] W-model applicability is recorded (single V or two-stage, with rationale).
- [ ] `ut-tdd plan lint` exits 0.
- [ ] `ut-tdd doctor` exits 0.
- [ ] Any PLAN split resulting from sizing is reflected in `requires` fields
      before pair-freeze.
