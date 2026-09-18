---
schema_version: skill.v1
name: design-doc
skill_type: design-contract
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
decision_points:
  - when: "Choosing how to source a diagram for a V-model layer doc"
    choose: "Use inline Mermaid by default"
    over: "Creating a standalone D2 source file"
    because: "D2 is reserved for cases needing layout control or reuse across more than one doc — Mermaid inline is the default"
  - when: "A diagram needs layout control or is referenced from more than one doc"
    choose: "Promote it to a D2 source file under docs/diagrams/ and commit the D2 source alongside any generated SVG"
    over: "Committing only the generated SVG"
    because: "The skill explicitly says never commit only the SVG — the D2 source is the single source of truth"
  - when: "A decision needs to be communicated via a diagram"
    choose: "State the decision in prose and let the diagram illustrate it"
    over: "Making the diagram the sole location where the decision is recorded"
    because: "The freeze checklist requires no diagram be the sole location of a decision — prose states it, the diagram illustrates it"
  - when: "A layer (L2-L4) mandates a diagram but it isn't ready yet"
    choose: "Block pair-freeze until the actual diagram exists"
    over: "Committing a 'TODO: add diagram' placeholder and proceeding to pair-freeze"
    because: "A layer that mandates a diagram cannot reach pair-freeze with a TODO placeholder"
  - when: "Producing a Reverse R2 as-is architecture diagram"
    choose: "Label it 'as-is' and date it"
    over: "Presenting it as an undated current/target-ambiguous diagram"
    because: "The freeze diagram checklist requires Reverse R2 diagrams be labeled as-is and dated"
---

# design doc

When and how to produce Mermaid / D2 diagrams as part of UT-TDD design docs.
Diagrams are versioned design artifacts, not illustrations, and pass the same
freeze readability check as prose.

## When to load this skill

- Authoring a `docs/design/` doc at L2–L5 that describes component structure,
  data flow, API sequence, or state transitions.
- Writing an ADR whose decision involves a system boundary or data model.
- A Reverse R2 pass capturing as-is architecture.

## Mermaid vs D2

Default to inline Mermaid for V-model layer docs. Promote to a D2 source file
(`docs/diagrams/`) only when layout control is needed or the diagram is
referenced from more than one doc (single source of truth). Commit D2 source
alongside any generated SVG — never commit only the SVG.

## Diagram obligation by layer

- **L2 (screen/IA):** a screen-flow or component-hierarchy `flowchart`.
- **L3 (functional):** a state-transition diagram per stateful feature; a
  sequence diagram per API surface.
- **L4 (basic):** a module component diagram; an ER diagram for DB changes.
- **L5 (detailed):** optional, when a class/data boundary is non-obvious.

## Mermaid templates (UT-TDD contexts)

PLAN lifecycle state:

```mermaid
stateDiagram-v2
  [*] --> plan
  plan --> pair_freeze: ut-tdd review --uncommitted
  pair_freeze --> implement
  implement --> trace_freeze: ut-tdd review --uncommitted
  trace_freeze --> review
  review --> accept
  accept --> [*]
```

harness.db projection (ER):

```mermaid
erDiagram
  PLAN_REGISTRY ||--o{ MODEL_RUNS : drives
  PLAN_REGISTRY {
    text plan_id PK
    text layer
    text drive
    text status
  }
  MODEL_RUNS {
    text run_id PK
    text plan_id FK
    text model
    text outcome
  }
```

## Freeze diagram checklist

- [ ] Every diagram has a one-sentence caption stating what it shows.
- [ ] Mermaid compiles without error (preview locally).
- [ ] Node labels match the L0 glossary and the prose terminology in the doc.
- [ ] D2 source is committed alongside the referencing doc.
- [ ] No diagram is the sole location of a decision — prose states the decision;
      the diagram illustrates it.
- [ ] Reverse R2 diagrams are labeled "as-is" and dated.

Run `ut-tdd review --uncommitted` after adding diagrams; a layer that mandates a
diagram cannot reach pair-freeze with a "TODO: add diagram" placeholder.
