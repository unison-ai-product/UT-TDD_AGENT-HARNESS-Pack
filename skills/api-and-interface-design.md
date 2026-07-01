---
schema_version: skill.v1
name: api-and-interface-design
skill_type: design-contract
applies_to:
  layers:
    - L2
    - L3
    - L4
  drive_models:
    - Forward
    - Discovery
    - Add-feature
    - Reverse
    - Refactor
---

# api and interface design

L2/L3 boundary design: screen/IA boundaries, component interaction contracts,
and the transition from user-facing information architecture to concrete L4
module interfaces. This skill governs *where boundaries are drawn* and *what
crosses them* — not the endpoint shape (see `api.md`) or the compatibility
contract (see `api-contract.md`).

## When to load this skill

- An L2 screen/IA design must identify which system boundaries a user action
  crosses.
- An L3 functional design introduces a new component boundary or renames an
  existing one.
- A Discovery Scrum S2 PoC needs a boundary sketch before code is written.
- A Refactor PLAN must confirm that no external interface boundary changes before
  pair-freeze.

## L2 boundary obligations

At L2 the question is: which screens or IA nodes produce or consume data across
a system boundary? For each boundary crossing, record:

- Source screen or agent action.
- Target component (CLI module, DB table, external service).
- Data direction (read / write / event).
- Ownership: who controls the schema on each side.

Produce a `flowchart` or component diagram (Mermaid inline) in the L2 design doc.
Every boundary in the diagram must map to a named L3 functional requirement or
placeholder with a `requires` dependency in the PLAN.

## L3 functional boundary rules

- Each IA boundary becomes a named **interface point** in the L3 doc with:
  an actor, a trigger, and the system response observable to that actor.
- Do not describe transport or encoding at L3 — that is L4.
- Where a boundary is shared with another PLAN's scope, create a `placeholder_dep`
  in the PLAN rather than duplicating ownership.

## Transition to L4

The L4 basic-design doc resolves each L3 interface point into a concrete module
boundary: function signature, command path, or HTTP route. The L4 doc must
reference the L3 interface-point name it implements — this is the trace edge
that `ut-tdd vmodel lint` checks.

## Pair-freeze checklist (L2/L3 boundary design)

- [ ] L2 doc contains a boundary diagram (Mermaid flowchart or component).
- [ ] Every boundary in the diagram has a named L3 interface point.
- [ ] Each interface point has a matching `requires` or `placeholder_dep` in the
      PLAN for the L4 doc that will resolve it.
- [ ] No boundary is owned by two PLANs simultaneously (check `ut-tdd graph`).
- [ ] `ut-tdd plan lint` and `ut-tdd doctor` exit 0.
- [ ] Refactor PLANs: confirm via `ut-tdd review --uncommitted` that no externally
      visible boundary name changed without a corresponding contract version bump.

## Discovery drive usage

During Scrum S2 PoC under Discovery drive, a lightweight boundary sketch (informal
component diagram in the PLAN doc itself) is sufficient. Before S3 verify the
sketch must be promoted to a proper L2 or L3 design doc and referenced by the
PLAN's `generates` field.
