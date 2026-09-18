---
schema_version: skill.v1
name: screen-driven-requirements
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L2
    - L3
  drive_models:
    - Forward
    - Add-feature
    - Discovery
decision_points:
  - when: "An L2 screen prototype is built for a feature whose L1 requirements are still vague or incomplete"
    choose: "treat the prototype as an elicitation device — walk through it and record every latent requirement it surfaces, then feed those back into the requirements draft before building the next screen"
    over: "treating the prototype purely as a visual mockup to sign off on and moving straight to the next screen"
    because: "the prototype's purpose in this model is to make latent requirements visible; using it only as a visual check throws away the requirement-discovery value and produces requirements that were never actually interrogated against a concrete UI"
  - when: "A screen prototype has proven out and the team is deciding whether to keep it or rebuild the screen from scratch for production"
    choose: "grow the prototype into the production screen (evolutionary), but discard the fake data / stub backend behind it"
    over: "throwing away the whole prototype and rebuilding the UI from a clean slate, or keeping the stub data wired into production"
    because: "the prototype UI is evolutionary and its layout/interaction decisions are real design output worth keeping, but the fake data behind it exists only to make elicitation fast and must not leak into the shipped contract"
  - when: "Requirements elicitation for a screen is in its early rounds"
    choose: "diverge first — dig for every plausible latent requirement without pruning — before applying MoSCoW to converge on what actually ships"
    over: "applying MoSCoW prioritisation from the first round, pruning candidate requirements as they surface"
    because: "pruning during divergence silently drops requirements that were never fully articulated; the model separates digging (divergence) from prioritising (convergence) so nothing is cut before it is even understood"
  - when: "The requirements ⇄ screen iteration has converged and it's time to declare the L1/L3 requirements frozen"
    choose: "freeze WHAT the requirements are (the baseline) while explicitly allowing the UI implementation to keep evolving afterward"
    over: "freezing the UI screens themselves as immutable at the same moment, or treating the requirements freeze as freezing all future iteration"
    because: "the model freezes requirements as a change-managed baseline, not the UI — the UI keeps growing toward production after the freeze, and conflating the two either blocks legitimate UI refinement or lets requirements keep drifting unchecked"
  - when: "A requirements freeze (moving L1/L3 from draft to baseline) is being requested"
    choose: "block the freeze unless a recorded prototype agreement exists (the screen-flow sign-off evidence, per [[design-doc]]'s L2 diagram obligation)"
    over: "freezing requirements based on prose review alone, with no linked prototype agreement artefact"
    because: "this is the explicit L2 freeze gate — requirements are elicited through screens, so a freeze with no recorded prototype agreement means the requirement was never actually validated against a concrete UI before being locked"
  - when: "After the requirements freeze, a stakeholder wants to change a frozen L1/L3 requirement based on new UI feedback"
    choose: "route the change through change management (a new PLAN or an amendment with recorded rationale), not through continued free iteration on the frozen doc"
    over: "editing the frozen requirements doc directly because the UI still 'feels wrong'"
    because: "the freeze is a baseline, and post-baseline changes are change-managed by design — treating it as still-open iteration defeats the purpose of freezing at all"
  - when: "A screen requirement (RS-) is being written up during elicitation"
    choose: "raise its resolution to cover state/transitions, primary operations, data demand (reads), accessibility/quality, and extension headroom — not just a static layout description"
    over: "recording only what the screen looks like (layout, copy) as the requirement"
    because: "a layout-only screen requirement under-specifies the contract the backend and test design need; state, operations, data demand, a11y, and headroom are the dimensions that actually drive API/table decisions and acceptance criteria downstream"
---

# screen-driven requirements

How to elicit latent requirements by iterating between L1/L3 requirements and
L2 screen prototypes, and how to freeze the result without losing what the
prototyping process discovered. This is the elicitation technique that feeds
requirements into the Forward workflow before pair-freeze; it governs the
requirements side, not the diagramming or handover mechanics.

## When to load this skill

- Starting requirements elicitation for a new feature where the requirement is
  genuinely unclear until someone sees a screen.
- An L2 screen prototype exists and it's time to decide what it revealed about
  L1/L3 requirements.
- A requirements freeze (L1/L3 baseline) is being requested and it's unclear
  whether the prototype-agreement gate has been satisfied.
- Writing or reviewing a screen-level requirement (RS-) and it's unclear how
  much resolution it needs.
- Deciding whether prototype code/data should be promoted toward production or
  thrown away.

## The core loop: requirements ⇄ screens

Requirements and screen prototypes are elicited by iterating between them, not
by writing requirements first and handing them to design:

1. Draft a rough requirement.
2. Build a screen prototype that embodies it.
3. Walk through the prototype — it makes latent requirements visible that the
   prose draft missed, and it defines what the *next* screen needs to cover.
4. Fold the newly-surfaced requirements back into the draft.
5. Repeat until the requirement set stabilises.

The prototype is an **elicitation device**, not a deliverable to sign off on
in isolation. Its value is in what it reveals, not just what it shows.

## Diverge, then converge

The early rounds of this loop are divergent: dig for every plausible latent
requirement without pruning. Only once the requirement space has been
genuinely explored does the team apply MoSCoW (Must/Should/Could/Won't) to
converge on what actually ships. Pruning during the divergent phase silently
discards requirements that were never fully articulated — converge later than
feels comfortable, not earlier.

## Evolutionary prototype, throwaway stub

The prototype UI itself is **evolutionary** — its layout and interaction
decisions are real design output and are expected to grow into the production
screen, not be discarded and rebuilt. The fake data and stub backend behind
the prototype are the opposite: **throwaway**. They exist only to make
elicitation fast, and must not leak into the production contract. When a
prototype is promoted, keep the UI, replace the stub with a real
service/contract boundary.

## The freeze gate: WHAT freezes, not the UI

The L1/L3 requirements freeze is a baseline for **WHAT** is required — it is
not a freeze on the UI implementation, which keeps evolving toward production
after the freeze. Two failure modes to avoid:

- Freezing the UI itself as immutable at the same moment (blocks legitimate
  screen refinement that doesn't change the underlying requirement).
- Treating the requirements freeze as still-open iteration (lets requirements
  drift after they were supposed to be locked).

**A requirements freeze without a recorded prototype agreement is forbidden.**
The prototype-agreement record (the screen-flow sign-off; see [[design-doc]]
for the L2 diagram obligation this pairs with) is the evidence that the
requirement was actually validated against a concrete UI before being locked
— not just reviewed in prose. Do not cross pair-freeze on an L1/L3 PLAN
without this evidence in `review_evidence`.

After the freeze, changes to a frozen requirement go through change
management (a new PLAN or an explicit amendment with recorded rationale) —
not through continued direct edits to the frozen doc.

## Raising screen-requirement resolution (RS-)

A screen requirement recorded only as a layout/copy description
under-specifies the contract that the backend, test design, and acceptance
criteria need downstream. Raise each RS- entry to cover:

- **State / transitions** — what states the screen can be in and how it moves
  between them.
- **Primary operations** — the actions a user can take from this screen.
- **Data demand (reads)** — what data the screen needs to render, which
  drives API/table decisions.
- **Accessibility / quality** — keyboard operation, focus order, tap-target
  size, and equivalent a11y concerns for the interaction model in use.
- **Extension headroom** — how much the screen's data/contract needs to
  tolerate future change before it forces a breaking API version.

## Boundary with existing skills

- **[[screen-driven-requirements]] (this skill)** governs the elicitation
  technique — how requirements and screen prototypes iterate to surface
  latent requirements, and the freeze gate that closes that iteration.
- **[[requirements-handover]]** governs how an already-elicited L1/L3
  requirement is baton-passed across sessions/agents once it exists — it
  assumes the elicitation in this skill has already produced the requirement.
- **[[poc]]** governs a time-boxed Discovery spike used to answer a binary
  hypothesis question. A screen prototype used for requirements elicitation is
  not automatically a PoC: use this skill when the goal is discovering what
  the requirement *is*, and [[poc]] when the goal is validating a specific
  technical hypothesis with a decision_outcome.

## Anti-patterns

- Treating a screen prototype as a mockup to approve rather than an
  elicitation device to interrogate for latent requirements.
- Pruning candidate requirements during the divergent (digging) phase instead
  of waiting for the MoSCoW convergence pass.
- Rebuilding a proven prototype UI from scratch instead of growing it, or
  conversely wiring its throwaway stub data into production.
- Freezing L1/L3 requirements with no recorded prototype agreement in
  `review_evidence` — this is the L2 freeze gate and cannot be skipped.
- Freezing the UI itself as if it were the requirement — the requirement
  freezes as a baseline; the UI keeps evolving toward production.
- Recording an RS- screen requirement as layout/copy only, omitting state,
  operations, data demand, a11y, or extension headroom.
