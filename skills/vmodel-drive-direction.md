---
schema_version: skill.v1
name: vmodel-drive-direction
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Discovery
    - Scrum
    - Add-feature
    - Reverse
    - Refactor
decision_points:
  - when: "choosing where to start driving a new feature slice"
    choose: "decide by the slice's dominant risk (domain consistency, UX/novelty, UI generation quality, or multi-client contract exposure)"
    over: "always starting backend-first (or always frontend-first) as a fixed process default"
    because: "drive direction is explicitly risk-dependent, not sequence-dependent — a fixed default ignores which failure mode is actually most expensive for this slice"
  - when: "the slice's dominant risk is domain consistency, invariants, or write-authority correctness"
    choose: "drive backend/domain-first, test-first, writing the test design before the implementation"
    over: "prototyping the UI first and inferring the domain shape from what the screen needs"
    because: "the domain core is the part that breaks expensively when wrong; test-first on the domain catches invariant violations before they are baked into a UI contract"
  - when: "the slice's dominant risk is UX validity or feature novelty (it is unclear what should even be built)"
    choose: "drive frontend-prototype-first, treating the prototype as evolutionary (kept and grown, not photographed-then-discarded)"
    over: "writing a full backend/domain design before any UI has validated what is actually needed"
    because: "when the uncertainty is 'what to build,' a backend-first design locks in assumptions before the UX question is answered, wasting the domain-design investment if the prototype invalidates it"
  - when: "the slice risk is AI-generated UI quality (novel, ungoverned AI output producing inconsistent or low-quality UI)"
    choose: "drive frontend-first but constrained by an explicit design system"
    over: "letting AI generate UI freely and reviewing/correcting after the fact"
    because: "the design system is the mechanism that keeps AI-generated UI inside acceptable bounds; frontend-first without that constraint just relocates the risk instead of controlling it"
  - when: "the slice will be consumed by more than one client type, or the contract shape itself carries risk"
    choose: "drive contract-first, letting backend and frontend proceed in parallel against the agreed contract"
    over: "resolving the frontend-first vs backend-first question by picking one side to lead"
    because: "contract-first is named as the practical default for multi-client work precisely because it dissolves the frontend-vs-backend ordering dilemma instead of picking a side"
  - when: "pairing V-model layers for a feature slice (design side to verification side)"
    choose: "pair by matching height (L1↔L12, L2↔L11, L3↔L10, L4↔L9, L5↔L8), not by fixed sequential order"
    over: "treating the V-model as a linear pipeline where each layer simply hands off to the next numbered layer"
    because: "height, not sequence number, is what defines a valid design/verification pair — L5 detailed design is verified by L8 unit tests, not by the numerically adjacent L6"
  - when: "authoring test design for a layer pair"
    choose: "author the test design on the descent (left side, alongside the matching design layer), and execute tests only on the ascent (right side, from L8 upward)"
    over: "deferring test design authorship until the ascent side is reached"
    because: "test design is explicitly shift-left in this V-model; deferring it to the ascent removes the design-time signal test-first authoring is meant to provide"
  - when: "a new feature slice needs shared domain concepts (value objects, aggregates, auth, tenant isolation)"
    choose: "route the slice to the centralized shared domain core"
    over: "implementing a slice-local copy of the same value object, aggregate rule, auth check, or tenant-isolation logic"
    because: "the shared domain core is explicitly centralized and must not be scattered into per-slice copies — duplication here is exactly the drift the centralization rule exists to prevent"
  - when: "deciding how to allocate implementation work between a human and an AI agent under the AI-era cost inversion (implementation is cheap; intent, taste, contracts, invariants, and verification are expensive)"
    choose: "keep intent, taste, contract definition, invariant definition, and verification as human-owned, and let AI implement within those machine-guarded constraints"
    over: "letting the AI agent also decide the contract shape, invariants, or acceptance criteria because it is also capable of writing that prose"
    because: "the ownership placement follows the cost inversion directly — the expensive, hard-to-verify decisions (intent/contract/invariant/verification) stay human-owned regardless of what the AI is technically capable of drafting"
  - when: "an AI agent repeatedly produces poor output in some domain (e.g. a UI pattern, a design decision)"
    choose: "treat it as a signal to add or tighten a constraint (e.g. a design system rule) and retry, adaptively widening delegation as the constraint proves sufficient"
    over: "concluding 'AI is bad at X' and permanently routing that class of work to a human"
    because: "the skill explicitly warns against fossilizing 'AI is bad at X' as a fixed belief — the corrective move is tightening the constraint boundary, not permanently narrowing delegation scope"
---

# vmodel drive direction

Governs two coupled judgements: (1) how V-model layers pair across the
descent/ascent and where test design and test execution sit in that pairing,
and (2) *where to start driving* a feature slice — which is a risk-dependent
choice, not a fixed process order. Distinct from `system-design-sizing.md`
(how big a PLAN/component should be), `spec-driven-development.md` (how a
spec at a given layer is authored), and `test-driven-development.md` (the
Red-Green-Refactor mechanics once implementation has started).

## When to load this skill

- Starting a new feature slice and it is unclear whether to begin with
  backend/domain, frontend prototype, or contract design.
- Pairing a design-side layer with its verification-side counterpart and the
  correct pair is not obvious from layer number alone.
- Deciding whether a piece of domain logic belongs in a shared core or can be
  slice-local.
- Deciding how much of a task to delegate to an AI implementation agent versus
  keeping it human-owned.
- An AI agent's output quality in some area is repeatedly poor and the next
  step (add a constraint vs. permanently exclude AI from that area) is
  unclear.

## Layer pairing is by height, not sequence

V-model layers pair by matching height across the descent (design) and ascent
(verification) sides, not by ascending numeric order:

```
L1 planning            <-> L12 operational test
L2 requirements (UI)   <-> L11 acceptance test
L3 requirements(frozen)<-> L10 system/integration test
L4 basic design        <-> L9  integration test
L5 detailed design     <-> L8  unit test
L6 implementation (product code)         -- descent
L7 test implementation <-> implementation -- apex, the V closes here
```

Test design is authored on the descent side (shift-left): the L5 detailed
design and its paired L8 unit-test design are produced together, before
implementation. Test *execution* happens only on the ascent side, from L8
upward. Treating the V as a linear pipeline that hands off strictly by layer
number (e.g. assuming L5 hands off to L6 the same way L6 hands off to L7) loses
this pairing and misplaces where verification design work belongs.

Run the V per feature slice, not once for the whole system: each slice is a
compressed L1-L12 pass aligned to a bounded context, so agile iteration and
the V-model coexist (agile x V) rather than competing.

## Where to start driving: decide by risk, not by fixed order

The V-model does not mandate a fixed starting side. The correct entry point is
the layer/side where the slice's dominant risk lives:

| Dominant risk in this slice | Recommended drive | Why |
|---|---|---|
| Domain (consistency, invariants, write-authority correctness) | Backend/domain-first, test-first | The core is the part that breaks expensively if wrong |
| UX validity / feature novelty (unclear what to build) | Frontend-prototype-first | What to build is the actual unknown; validate before investing in domain design |
| AI-generated UI quality risk | Frontend-first, constrained by a design system | The design system is what keeps AI-generated UI inside bounds |
| Multi-client / contract exposure | Contract-first (backend and frontend proceed in parallel) | This is the practical default — it dissolves the frontend-vs-backend ordering question rather than picking a side |

Backend-first is not a universal default and frontend-first is not an
exception to apologize for — both are correct depending on which risk
dominates. When a slice has no clearly dominant risk, contract-first is the
practical default because it avoids forcing a premature choice between the
other two.

A prototype produced under frontend-prototype-first drive is evolutionary: it
is kept and grown toward production, not photographed once and discarded —
throwaway stub data behind it is what gets discarded, not the prototype
structure itself.

## Shared domain core stays centralized

Value objects, aggregates, authentication, and tenant-isolation logic are a
shared domain core. When a new feature slice needs any of these, it must route
to the centralized core, never re-implement a slice-local copy — even under
contract-first or frontend-first drive, the domain core is not something each
slice owns independently. Cross-cutting concerns (auth, tenant isolation) stay
governed centrally under the same shared-core discipline regardless of which
side drove the slice.

## AI-era ownership placement

The cost inversion under AI-assisted implementation is: implementation is
cheap, while intent, taste, requirements, contracts, invariants, and
verification are expensive (hard to get right, expensive to get wrong).
Ownership placement follows this directly:

- **Human-owned:** intent, taste, contract definition, invariant definition,
  verification/acceptance criteria.
- **AI-owned:** implementation within the constraints the human has set.
- **The boundary between them is machine-guarded** (types, closures,
  validation gates) and deliberately movable — it is not a permanent line.

Do not fossilize "AI is bad at X" as a static belief. When AI output is
repeatedly poor in some area, the corrective action is to add or tighten a
constraint (e.g., a design system, a stricter schema, a narrower interface)
and retry — adaptively widening delegation once the constraint proves
sufficient, rather than permanently excluding AI from that class of work.

## Checklist before starting a new feature slice

- [ ] The slice's dominant risk category has been named explicitly (domain /
      UX-novelty / AI-UI-quality / multi-client-contract).
- [ ] The drive direction chosen matches that dominant risk, or contract-first
      is used as the default when no single risk dominates.
- [ ] The design-side and verification-side layers for this slice are paired
      by height, and test design work is scheduled on the descent side.
- [ ] Any shared domain concept (VO/aggregate/auth/tenant isolation) touched
      by this slice routes to the centralized core, not a slice-local copy.
- [ ] The human/AI ownership split for this slice keeps intent, contract,
      invariant, and verification decisions human-owned.

## Anti-patterns

- Always starting backend-first regardless of the slice's actual risk profile
  — this ignores the risk-dependent drive-direction rule this skill exists to
  enforce.
- Treating L-number adjacency as the pairing rule (e.g. assuming L4 pairs with
  L5) instead of height-based pairing (L4 pairs with L9).
- Re-implementing a value object, aggregate rule, auth check, or
  tenant-isolation check inside a single feature slice instead of using the
  shared domain core.
- Concluding "AI can't do X" permanently instead of tightening the
  constraint boundary and retrying.

## External corroboration

- Walking Skeleton (Alistair Cockburn) — https://www.henricodolfing.com/2018/04/start-your-project-with-walking-skeleton.html (surface the largest unknown first; the starting point is risk-driven, never a fixed template)

