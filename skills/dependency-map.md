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
---

# dependency map

Cross-module dependency detection, PLAN dependency graph analysis, and the
`ut-tdd graph` / `ut-tdd doctor` surfaces that expose dependency drift
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
TypeScript `import` paths across `src/` sub-modules. Detected by `bun run
typecheck` and inspectable via `ut-tdd graph` (module dependency view).

## Mapping procedure

1. Run `ut-tdd graph` to get the current dependency view for the affected
   modules. Note any cycles or cross-layer imports.
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

- [ ] Run `ut-tdd graph` on HEAD and on the base commit; confirm edges are
      identical for external-facing modules.
- [ ] `bun run typecheck` exits 0 — no new import errors.
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
