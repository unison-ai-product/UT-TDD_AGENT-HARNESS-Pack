---
schema_version: skill.v1
name: contract-envelope-design
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Reverse
decision_points:
  - when: "designing a contract shape and the only reference is the current screen's read/write needs"
    choose: "generalize the contract with headroom for adjacent, foreseeable client needs"
    over: "photographing the current screen's fields one-to-one into the contract"
    because: "a contract cut narrowly to one screen makes every future UI change trigger a backend change, which is the brittleness this skill exists to prevent"
  - when: "a screen needs a new field, filter, or action that is already inside the existing contract/data envelope"
    choose: "let the UI change freely with zero backend or contract change"
    over: "opening a backend/contract PLAN for a change the envelope already covers"
    because: "changeability is maximized inside the envelope; routing an in-envelope UI change through a backend PLAN wastes the headroom the contract was built for"
  - when: "a screen needs data or an operation the current contract/data envelope does not supply"
    choose: "treat it as an envelope-expansion event and run it through contract versioning (compatibility class, consumer list, deprecation if breaking)"
    over: "quietly widening the existing contract's meaning or overloading an existing field to smuggle the new demand through"
    because: "new data demand is explicitly the trigger for envelope expansion — expanding a field's meaning without a version event hides the change from every other consumer"
  - when: "the screen's needs and the domain's write/consistency rules disagree on the shape of an operation"
    choose: "let the domain's write authority and invariants constrain the contract, and adjust the screen to the constrained shape"
    over: "shaping the contract to match what the screen wants and letting the domain adapt around it"
    because: "the domain is the source of write authority, invariants, and consistency — the screen must never be allowed to subordinate the domain to UI convenience"
  - when: "a new AI agent client needs to consume an existing contract"
    choose: "treat the addition as an envelope-expansion event and route it through the same validated intermediate-JSON seam (schema-checked wire boundary) as any other client"
    over: "giving the agent a bespoke, unvalidated integration path that bypasses the schema/wire boundary"
    because: "adding a client type is explicitly named as an envelope-expansion event; skipping the validated seam breaks the single-source-of-truth schema discipline every other client relies on"
  - when: "deciding where structural/format validation for a field lives versus where cross-field business logic lives"
    choose: "put structure, format, and single-field constraints in the schema/wire boundary (JSON Schema / Zod / pydantic), and keep cross-field or cross-aggregate business logic in the domain"
    over: "encoding business logic as ad hoc schema constraints, or leaving structural validation to be re-implemented per client"
    because: "structural and single-field concerns are schema-capturable and should be captured once at the wire boundary; business logic that spans fields or aggregates belongs to the domain, which is the single write authority"
  - when: "a contract field needs to be removed or renamed because the screen no longer uses it"
    choose: "run it through the compatibility-class deprecation policy (notice, deprecation period, sunset date) before removal"
    over: "deleting or renaming the field as soon as the current screen stops referencing it"
    because: "the contract supplies all clients, not just the current screen — a field with other consumers can only be retired through the deprecation policy, never through single-screen convenience"
---

# contract envelope design

Contract-envelope judgement: where changeability lives (inside the contract's
data envelope) and when a change is a version event (envelope expansion).
This skill governs the *design judgement* of drawing and growing the envelope
boundary — not contract mechanics (see `api-contract.md`) or endpoint/boundary
shape (see `api-and-interface-design.md`).

## When to load this skill

- An L3/L4 contract is being derived from a single screen's read/write/
  operation needs and must be checked for over-narrowness before it is written
  down.
- A new client (including an AI agent) needs to consume an existing contract
  and it is unclear whether this is an in-envelope change or a version event.
- A screen's data demand and the domain's write/consistency rules appear to
  conflict and it must be decided which side yields.
- A PLAN proposes removing or renaming a contract field and the correct
  deprecation path is unclear.

## Role split: screen, contract, domain

Three roles cooperate at a contract boundary, and none may absorb another's
job:

- **Screen** — *teaches* the contract. It concretizes read/operation/extension
  demand: what data is read, what operations are triggered, what extension
  points (a11y, future filters, pagination) are foreseeable from the current
  UI shape. The screen is the discovery mechanism for contract requirements,
  not the contract's final shape.
- **Domain** — *constrains* the contract. It owns write authority, invariants,
  and consistency rules. The domain is never subordinate to the UI: if a
  screen's desired shape would violate an invariant or blur write authority,
  the domain wins and the screen adapts.
- **Contract** — *supplies* all clients. It is the single, versioned, general
  interface every consumer (screen, other services, AI agents) reads and
  writes through. It is not a private channel for one screen.

## Generalize with headroom, not a screen photograph

A contract designed by copying exactly what one screen currently reads and
writes is a **screen photograph**. It looks correct on day one and becomes
brittle immediately: because the contract only supplies what the current
screen consumes, any new UI need — a filter, a derived field, an extra
action — has nowhere to land inside the existing shape, so it forces a
backend/contract change for what should be a pure UI change.

Instead, generalize:

- Include fields and operations that are foreseeable extensions of the
  screen's demand (the screen's own extension-point resolution should surface
  these), not just what today's rendering needs.
- Size the envelope for "the class of screens this domain concept will ever
  need to serve," not "this exact screen."
- Prefer a slightly wider, well-typed contract over a minimal one that will be
  outgrown within the same feature slice.

## The envelope: what changes freely, what is a version event

**Inside the envelope** (no backend/contract change required):

- Any UI change that only re-arranges, re-labels, filters, or re-composes
  data and operations the contract already supplies.
- Changeability is maximized here — this is the entire purpose of generalizing
  the contract with headroom.

**Envelope expansion** (a version event, governed by `api-contract.md`'s
compatibility-class and deprecation rules):

- New data demand that the current contract does not supply.
- Adding a new client type (including an AI agent) — this must go through the
  same validated intermediate-JSON seam (schema/wire validation) as existing
  clients, never a bespoke bypass.
- Any change that would alter write authority or invariants the domain
  currently guarantees.

Removing or renaming an already-supplied field is also an envelope-narrowing
event and must run through the same deprecation-period discipline defined in
`api-contract.md`, regardless of whether only one current consumer uses it —
the contract's promise is to all clients, not the one currently visible.

## Boundary with existing skills

- `skills/api-contract.md` governs contract *mechanics*: compatibility
  classes, consumer lists, deprecation periods, version bumps, and the
  Reverse R1 extraction procedure. This skill governs the *judgement* of
  where the contract's boundary should sit and when a proposed change is
  in-envelope versus an envelope-expansion (version) event. Use this skill to
  decide *whether* something is a version event; use `api-contract.md` to
  execute the version event correctly.
- `skills/api-and-interface-design.md` governs L2/L3 *boundary placement*:
  which screens/components cross which system boundary, and interface-point
  naming. This skill assumes a boundary already exists and governs the
  *shape and growth discipline* of the contract that sits on that boundary.

## Design checklist

- [ ] The contract was derived by generalizing screen demand with headroom,
      not by copying one screen's exact field list.
- [ ] Domain write authority and invariants are stated explicitly and the
      contract does not contradict them.
- [ ] Every field/operation the contract supplies is available to all known
      and foreseeable clients, not scoped to one screen.
- [ ] New data demand not covered by the current envelope is routed through
      `api-contract.md` versioning, not silently absorbed into an existing
      field's meaning.
- [ ] A new client type (including an AI agent) integrates through the
      validated schema/wire seam, not a bespoke unvalidated path.
- [ ] Field removal/rename follows the deprecation-period policy even when
      only one visible consumer currently uses the field.

## Anti-patterns

- Treating "the screen needs it" as sufficient justification to widen an
  existing field's meaning instead of running an explicit version event.
- Letting the domain's invariants bend to match a screen's preferred payload
  shape — this inverts the constrain relationship and risks consistency bugs.
- Designing a contract narrowly "for now" with the intent to widen it later —
  this guarantees the brittle UI-change-triggers-backend-change cycle this
  skill exists to prevent.

## External corroboration

- Martin Fowler, "Consumer-Driven Contracts" — https://martinfowler.com/articles/consumerDrivenContracts.html (consumers declare only fields they read; provider keeps headroom)
- Pact, versioning in the Pact Broker — https://docs.pact.io/getting_started/versioning_in_the_pact_broker (pair loose contracts with machine can-i-deploy verification)

