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
decision_points:
  - when: "describing a boundary crossing at L3"
    choose: "state only the actor, trigger, and observable system response"
    over: "describing transport or encoding details (headers, serialisation format) at L3"
    because: "transport/encoding is explicitly out of scope at L3 — that belongs to L4"
  - when: "an L2/L3 boundary is shared with another PLAN's scope"
    choose: "create a placeholder_dep in the PLAN"
    over: "duplicating ownership of that boundary in both PLANs"
    because: "no boundary may be owned by two PLANs simultaneously — duplication breaks single ownership"
  - when: "documenting who owns which side of a boundary in the L2 diagram"
    choose: "record ownership explicitly per boundary crossing (source, target, direction, schema owner)"
    over: "leaving ownership implicit and inferable only from the diagram shape"
    because: "each boundary-crossing record requires explicit ownership so trace-lint and cross-PLAN checks can verify it"
  - when: "a Discovery Scrum S2 PoC needs a boundary sketch"
    choose: "use a lightweight informal component diagram directly in the PLAN doc"
    over: "authoring a full L2/L3 design doc before any code is written"
    because: "S2 PoC explicitly allows an informal sketch; formalisation is deferred to before S3 verify"
  - when: "an S2 PoC is about to proceed to S3 verify"
    choose: "promote the informal sketch to a proper L2 or L3 design doc referenced by the PLAN's generates field"
    over: "carrying the informal sketch forward as the permanent design record"
    because: "the informal sketch is only sufficient pre-S3 — it must be promoted before S3 verify per Discovery drive usage"
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
- [ ] No boundary is owned by two PLANs simultaneously (check `ut-tdd graph export --format mermaid`).
- [ ] `ut-tdd plan lint` and `ut-tdd doctor` exit 0.
- [ ] Refactor PLANs: confirm via `ut-tdd review --uncommitted` that no externally
      visible boundary name changed without a corresponding contract version bump.

## Discovery drive usage

During Scrum S2 PoC under Discovery drive, a lightweight boundary sketch (informal
component diagram in the PLAN doc itself) is sufficient. Before S3 verify the
sketch must be promoted to a proper L2 or L3 design doc and referenced by the
PLAN's `generates` field.
