---
schema_version: skill.v1
name: vmodel-stage-upstream
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
  - when: "Drafting a charter/business-plan document for a new initiative or feature"
    choose: "pin purpose, target/problem, MVP scope (in-scope and explicitly out-of-scope), and success KPIs stated as measurable metrics that a later operational-test pass can check"
    over: "writing vision/mission prose with a scope list but no measurable success criteria"
    because: "the source charter's KPI table and roadmap exist specifically so a later operational-verification pass has something concrete to check against; a charter with only prose vision gives that later check nothing to verify."
  - when: "Eliciting a demand (business, screen, functional, or non-functional) before requirements are frozen"
    choose: "assign it an ID immediately from its category prefix and record source/priority/destination columns in the demand list, even while the demand is still rough"
    over: "capturing demands as free-text paragraphs and deferring IDs until requirements are written"
    because: "both the demand document and the requirements ledger are ID-first from the start; an un-IDed demand cannot be tracked to its fulfillment state in the ledger and tends to get silently dropped during convergence."
  - when: "Writing a screen-level demand row during elicitation"
    choose: "raise its resolution to cover state/transitions, primary operations, data demand (reads), accessibility/quality, and extension headroom"
    over: "recording only layout and copy for the screen"
    because: "a layout-only screen demand under-specifies exactly the dimensions that later drive API/table decisions and acceptance criteria; the source demand document treats screen demands as the foundation UI-driven elicitation stands on and requires that resolution up front."
  - when: "Converting a demand into a frozen requirement (functional, non-functional, or interface requirement)"
    choose: "split any requirement whose sentence contains a compound behaviour joined by 'and'/'or' into separate requirement IDs, each a single verifiable sentence"
    over: "keeping the compound behaviour under one requirement ID because the two halves are related"
    because: "each requirement row in the source requirements document already declares its downstream test IDs (unit/integration/system/acceptance) in a single column; a compound sentence cannot map 1:1 onto that column, and the requirement-to-test trace breaks at the point it is written, not later."
  - when: "A requirement is genuinely undecided at the point requirements would otherwise be frozen"
    choose: "record it explicitly in a dedicated open-items section with a target decision date, and keep the requirements freeze pending on that item"
    over: "guessing a plausible value to make the requirements table look complete, or silently dropping the undecided point"
    because: "the source requirements document carries a first-class open-items section with a decision-date column for exactly this state; treating 'undecided' as a trackable state, not a gap to paper over, is what keeps the frozen baseline honest."
  - when: "Requirements exist across the charter, demand document, and requirements document and their fulfillment state needs to be checked"
    choose: "treat the cross-document requirements ledger as the single register of ID, status, priority, and requirement-to-design-to-test expansion, and read it before trusting any individual document's own list"
    over: "letting each upstream document maintain its own untracked list of IDs and cross-referencing them by hand"
    because: "the source documents explicitly refuse to define new IDs locally ('new IDs are not defined here') precisely because the ledger's fulfillment summary is what catches a missing requirement-to-design-to-test link early; treating a document-local list as authoritative reintroduces the gap the ledger exists to close."
  - when: "Scoping how much demand/requirement apparatus to produce for a PoC-scale project"
    choose: "write requirements as falsifiable hypotheses with a stated success criterion (a spike question and a done condition), and skip the full ID-ed ledger, MoSCoW table, and requirement-to-test-ID columns"
    over: "building the complete demand list, requirements ledger, and per-requirement test-ID linkage as if the PoC were a Standard-scale product"
    because: "the full traceability apparatus this stage otherwise mandates (ID prefixes, ledger fulfillment rate, per-requirement test columns) is overhead that a throwaway PoC spike does not recoup; a PoC needs only what a spike's Objective/Spike-question/Done-condition already gives it."
  - when: "Scoping the demand/requirement documents for an Enterprise-scale, audit-exposed project"
    choose: "keep the full ID-ed ledger and additionally record any technology or architecture selection behind a business/system-plan document's cost-benefit section as an ADR, not just a table row"
    over: "treating the Standard-scale ID-plus-MoSCoW ledger as sufficient once every ID has an entry"
    because: "the source business-analysis/system-plan document requires a selection-rationale section for exactly this reason; an Enterprise project's audit exposure means a technology choice with no durable rationale record is undiscoverable later, even if the requirement itself is fully ID-ed and traced."
---

# vmodel stage: upstream (planning, demands, requirements)

What the planning/charter, demand-elicitation, and requirements-freeze stage of
the V-model (source levels L1–L3: 企画 / 要求 / 要件) must produce before a
project can hand off to basic design. This stage's job is to turn "why we are
building this" into a frozen, traceable "what the system must do" — it does
not decide how the system is structured (see
[[vmodel-stage-architecture]] for that).

## When to load this skill

- Authoring or reviewing a project/feature charter (purpose, KPIs, scope,
  roadmap, risk, alternatives).
- Running requirements elicitation and it is unclear how much resolution a
  demand (business, screen, functional, non-functional) needs before it is
  usable.
- Deciding whether a requirement is ready to freeze, or whether it belongs in
  an open-items/TBD section instead.
- Reviewing or maintaining the cross-document requirements ledger and its
  fulfillment-rate summary.
- Scoping how much of this stage's apparatus (ID prefixes, ledger, MoSCoW,
  ADR-backed selection rationale) a given project's scale actually needs.

## The charter: what a plan/business document must pin down

A charter document is not a pitch; it is the artifact later stages and the
final operational-verification pass check work against. It must fix:

- **Purpose and vision** as a short, falsifiable statement of what the product
  does for whom.
- **Target and problem** — who has which problem, stated concretely enough
  that a demand can be traced back to it (each named problem should map to at
  least one downstream demand ID).
- **MVP scope**, split explicitly into in-scope and out-of-scope (next-phase)
  items — an unscoped charter cannot bound the requirements stage that follows
  it.
- **Success KPIs** as measurable metrics with a definition of how each is
  measured, not aspirational prose — these are exactly what a later
  operational-test pass checks the shipped product against.
- **Risk and alternatives** — named risks with mitigations, and a comparison
  of the rejected alternatives with the reason the chosen approach won. A
  charter that records only the chosen approach loses the rationale a future
  reviewer needs to know the alternatives were actually considered.

## Demand elicitation (要求): how demands are recorded

Demands are elicited across four categories, each with its own ID prefix so
they can be tracked independently through the rest of the pipeline:

- **Business demands** — tied to a KPI or business outcome.
- **Screen demands** — UI/operation-level demands, elicited through screen
  prototypes (see [[screen-driven-requirements]] for the elicitation
  technique itself; this skill covers what the demand document and stage
  exit criteria require, not the iteration mechanics).
- **Functional demands** — what the system must do.
- **Non-functional demands** — quality characteristics (availability,
  security, scalability, performance, observability, compliance).

Each demand row carries: an ID, a priority (MoSCoW), a source (which problem
or stakeholder it traces back to), and a destination (which requirement it
is expected to expand into). User stories are recorded separately and linked
to the functional demand IDs they justify, not folded into the demand text
itself.

Elicitation follows the model diverge-then-converge: early rounds dig for
every plausible demand without pruning; only once the demand space has been
explored does MoSCoW prioritization narrow it down to what actually ships.
Pruning during the divergent phase silently drops demands that were never
fully articulated.

## Requirements freeze (要件): what "frozen" requires

A requirement (functional, non-functional, or external-interface) is the
system-facing translation of a demand, and becomes the baseline once frozen:

- **One requirement ID = one verifiable sentence.** A requirement joined by
  "and"/"or" across two distinct behaviours must be split into separate IDs
  before freeze, because one ID must trace 1:1 to a test case.
- **Each requirement already names its downstream test destinations** (unit,
  integration, system, acceptance) at requirements-writing time, not later —
  the requirement document declares which test kinds will exercise it even
  before any design or test-design doc exists. This is a forward
  traceability contract, not a prediction to be revisited casually.
- **Data-item definitions travel with the requirement**, not with the design
  — type, size, and required/optional status for every business data item are
  fixed here, and every business entity carries the tenant/ownership key that
  later isolation design depends on.
- **Undecided points get a first-class open-items section**, each with a
  target decision date. A requirement doc with no open-items section but
  hidden gaps is worse than one with an honest, dated open-items list.
- **The freeze is a baseline for WHAT, not for the UI.** Once L1/L3
  requirements are frozen, changes route through change management (a new
  PLAN or an explicit amendment); the UI implementation itself keeps evolving
  toward production after the freeze (see [[screen-driven-requirements]] for
  the freeze-gate mechanics, including the requirement that a recorded
  prototype-agreement artefact exists before this freeze is valid).

## The requirements ledger's role

A cross-document requirements ledger (a management register spanning
business, screen, functional, and non-functional demands and their expanded
requirements) is the single place where ID, category, priority, source,
expansion destination, and status are tracked together — separate from, and
authoritative over, any individual document's own local list. Its fulfillment
summary (demand count vs. requirements-expanded count vs. design-linked count
vs. test-linked count, per category) exists to catch a broken trace early,
before it surfaces as a missing test or an unimplemented requirement. Upstream
documents deliberately do not define new IDs locally — every ID is defined
once, registered in the ledger, and referenced everywhere else.

## Stage exit criteria / handoff to design

This stage is done, and basic design (L4) can begin, when:

- Every frozen requirement ID (functional, non-functional, interface) is
  registered in the ledger with status "requirements-expanded" and has a
  declared trace to its originating demand.
- The L2 freeze gate is satisfied: a recorded screen-prototype agreement
  exists in the review evidence before requirements are declared frozen (see
  [[screen-driven-requirements]]) — a requirements freeze with no such
  record is invalid regardless of how complete the requirements text looks.
- No requirement remains "TBD" without an open-items entry and a target
  decision date.
- The requirements-to-test-destination columns are populated (which test
  kinds each requirement expects), even though the tests themselves do not
  yet exist — this is what the paired verification level (system test, per
  the L3⇔system-test pairing) will later check the requirement against.

## Product-pattern conditioning

The amount of apparatus this stage produces should scale with the project,
not default to the heaviest form:

- **PoC scale**: skip the ID-ed ledger, MoSCoW table, and per-requirement
  test-ID columns. Write requirements as falsifiable hypotheses — a spike
  question and a done condition — because the full traceability apparatus is
  overhead a throwaway spike will not recoup.
- **Standard scale**: every demand and requirement is ID-ed, prioritized with
  MoSCoW, registered in the ledger, and traced to its expected test kind.
- **Enterprise scale**: everything in Standard, plus an ADR-backed rationale
  for any technology or architecture selection surfaced in a
  business/system-plan document's cost-benefit analysis — a table row noting
  "chosen: option C" is not sufficient audit evidence on its own; write the
  ADR.

## Boundary with existing skills

- **[[vmodel-stage-upstream]] (this skill)** covers what the charter, demand,
  and requirements documents must each produce, and this stage's exit
  criteria — not how any individual document is formatted or frozen for
  readability, and not the elicitation *technique* itself.
- **[[screen-driven-requirements]]** owns the requirements⇄screen elicitation
  loop, the diverge/converge discipline, and the L2 freeze-gate mechanics in
  detail. This skill references that freeze gate as an exit criterion but
  does not re-specify how to run the loop.
- **[[spec-driven-development]]** governs the L5+ detailed-design spec
  contract that test design pairs against, once this stage's frozen
  requirements have already been handed to design.
- **[[design-doc]]** governs diagram sourcing and diagram obligations once a
  doc's content is being written — this skill does not decide Mermaid-vs-D2,
  only that a charter/demand/requirements doc's tables and sections exist.
- **[[design-tailoring-and-granularity]]** governs the general which-docs
  and how-much-detail judgement (todo/na, PoC/Standard/Enterprise
  granularity, ADR placement) that this skill's product-pattern conditioning
  section applies specifically to the upstream (L1–L3) stage.

## Anti-patterns

- Writing a charter with a scope list and roadmap but no measurable KPI —
  there is nothing later for an operational-test pass to verify against.
- Capturing demands as prose paragraphs and deferring ID assignment until
  requirements time — un-IDed demands go untracked in the ledger.
- Recording a screen demand as layout/copy only, omitting state, operations,
  data demand, a11y, or extension headroom.
- Pruning candidate demands during the divergent elicitation phase instead of
  waiting for the MoSCoW convergence pass.
- Keeping a compound requirement ("X and Y") under a single ID — breaks the
  1:1 requirement-to-test trace the requirement document's test-destination
  column depends on.
- Guessing a value for an undecided requirement to make the table look
  complete, instead of recording it in the open-items section with a
  decision date.
- Treating any single upstream document's local list as authoritative over
  the requirements ledger, or defining a new ID outside the ledger.
- Applying Enterprise-weight demand/requirement apparatus to a PoC spike, or
  Standard-weight apparatus with no ADR to an Enterprise-scale technology
  selection.
