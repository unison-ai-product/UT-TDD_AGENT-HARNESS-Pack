---
schema_version: skill.v1
name: dependency-map
skill_type: verification
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
  drive_models:
    - Forward
    - Reverse
    - Add-feature
    - Refactor
decision_points:
  - when: "A PLAN actually consumes another PLAN's generated artifact but requires is left empty"
    choose: "Declare the dependency explicitly in requires"
    over: "Leaving requires: [] because the coupling is 'implicit' or obvious"
    because: "An implicit-but-undeclared dependency is listed as an anti-pattern — it must be made explicit"
  - when: "A placeholder_deps forward reference is still unresolved at trace-freeze"
    choose: "Resolve it before trace-freeze, blocking progression to accept if unresolved"
    over: "Carrying the placeholder past trace-freeze as a convenience"
    because: "Every placeholder must resolve or the PLAN cannot reach accept"
  - when: "ut-tdd plan lint reports a dependency-lint error for a requires entry that references a non-existent PLAN"
    choose: "Create the missing PLAN that the requires entry points to"
    over: "Deleting the requires entry to make the lint error go away"
    because: "Removing the requires entry instead of creating the missing PLAN is listed as an anti-pattern"
  - when: "A Refactor PLAN claims external interfaces are unchanged"
    choose: "Prove it with a ut-tdd graph diff between HEAD and base commit showing identical external-facing edges"
    over: "Asserting interface-neutrality in prose without a graph comparison"
    because: "The Refactor gate requires ut-tdd graph run on HEAD and base commit with identical edges as evidence, not a prose claim"
  - when: "ut-tdd doctor fires a dependency-drift or orphan finding"
    choose: "Trace the chain to find which upstream PLAN owns the artifact/module before editing anything"
    over: "Editing PLAN YAML or imports speculatively to silence the finding"
    because: "The mapping procedure requires tracing the chain (which upstream PLAN owns the artifact) before updating requires/placeholder_deps or imports"
---

# dependency map

Cross-module dependency detection, PLAN dependency graph analysis, and the
`ut-tdd graph impact` / `ut-tdd graph export` / `ut-tdd doctor` surfaces that expose dependency drift
(FR-L1-18 doctor cross-detection aggregation). Apply when a PLAN touches
module boundaries, PLAN `requires`/`parent` fields, or when `ut-tdd doctor`
reports a dependency-governance violation.

## When to load this skill

- A PLAN's `requires` or `parent` field references another PLAN and the
  relationship must be validated.
- `ut-tdd doctor` fires a dependency-drift or orphan finding.
- An L4 design doc introduces a new module dependency and the impact must be
  mapped before pair-freeze.
- A Refactor PLAN claims to leave external interfaces unchanged — dependency map
  is the evidence.

## Types of dependencies in UT-TDD

**PLAN structural dependencies (`requires`, `parent`, `parent_design`):**
expressed in PLAN YAML; machine-checked by `ut-tdd plan lint` (existence) and
`ut-tdd doctor` (plan-governance). A `requires` that references a non-existent
PLAN ID is a blocking lint error.

**Artifact dependencies (`generates`, `placeholder_deps`):**
a PLAN `generates` doc that does not exist at pair-freeze is a governance
violation. `placeholder_deps` allows forward references during design; they must
resolve before trace-freeze.

**Source-level module dependencies:**
TypeScript `import` paths across `src/` sub-modules. Detected by `npm run
typecheck` and inspectable via `ut-tdd graph export --format mermaid` (relation-graph diagram).

## Mapping procedure

1. Run `ut-tdd graph impact --changed <path...>` (or `ut-tdd graph export
   --format mermaid` for the full diagram) to get the current dependency view
   for the affected modules. Note any cycles or cross-layer imports.
2. Run `ut-tdd doctor` and read the full output (never `| tail`). Dependency-
   governance findings name the specific PLAN or artifact that is broken.
3. For each finding, trace the chain: which upstream PLAN owns the artifact or
   module? Is the dependency declared in `requires`?
4. Update PLAN YAML (`requires` / `placeholder_deps`) or source imports to match
   the intended dependency graph, then re-run both commands until both exit 0.

## L4 dependency contract

When an L4 design doc introduces a new module dependency, add a
`## Dependencies` section listing each dependency with:
- Dependency name (module path or PLAN ID).
- Direction (this module consumes / provides).
- Coupling strength (interface-only / implementation detail).
- Change-risk note (is this dependency `stable` or `internal`?).

This section is read during `ut-tdd review --uncommitted` to confirm no hidden
coupling was introduced.

## Refactor gate: dependency-neutrality check

A Refactor PLAN must prove that no external dependency graph edge changed. Before
pair-freeze:

- [ ] Run `ut-tdd graph export --format mermaid` on HEAD and on the base commit; confirm edges are
      identical for external-facing modules.
- [ ] `npm run typecheck` exits 0 — no new import errors.
- [ ] `ut-tdd doctor` exits 0 — no new orphans or dependency-drift findings.
- [ ] `ut-tdd review --uncommitted` produces no new cross-module coupling
      findings.

## Anti-patterns

- Declaring `requires: []` on a PLAN that actually consumes another PLAN's
  generated artifact — the dependency exists implicitly; make it explicit.
- Using `placeholder_deps` past trace-freeze — every placeholder must resolve
  or the PLAN cannot reach `accept`.
- Fixing a dependency-lint error by removing the `requires` entry instead of
  creating the missing PLAN.
