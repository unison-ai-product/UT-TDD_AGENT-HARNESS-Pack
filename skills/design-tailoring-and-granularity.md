---
schema_version: skill.v1
name: design-tailoring-and-granularity
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Reverse
decision_points:
  - when: "A candidate design-doc topic (e.g. tenant lifecycle, batch processing, DR/BCP) does not correspond to anything the project actually has"
    choose: "mark the doc `na` (out of scope) and record the structural reason in the tailoring note"
    over: "leaving it as an empty `todo` stub that nobody fills in"
    because: "`na` is only valid when the concern is structurally absent from the project; leaving a genuinely absent concern as an unfillable todo just clutters the doc set without adding traceability"
  - when: "A design-doc topic applies to the project but is not yet decided, or feels tedious to write up"
    choose: "keep it `todo` and push the open question into the risk register / debt register (`docs/plans/PLAN-*` debt entry, per [[debt-register]]) or the doc's own TBD section"
    over: "marking it `na` to make a coverage gate go green"
    because: "changing status to `na` for a concern that structurally exists is a false-green — it hides an undecided risk instead of tracking it, and PO rules treat gate-green-by-relabeling as a claim-discipline violation"
  - when: "Deciding whether a given design topic needs its own doc at all"
    choose: "ask the two self-questions: (1) would someone be stuck during an incident, audit, or handover without this information, and (2) is the authoritative source for this information already recorded elsewhere"
    over: "defaulting to writing every catalog topic because the template exists"
    because: "these are the concrete tests the tailoring judgement reduces to — 'yes' to (1) means todo, 'yes' to (2) means na (duplicate definitions are also a downstream drift source), and skipping the questions leads to either bloat or a real gap"
  - when: "Setting the target granularity for a design doc"
    choose: "match effort to project scale: PoC states only what is being validated and its success criteria; Standard traces every requirement to an ID and a test; Enterprise additionally writes audit-facing docs (security, privacy, controls mapping) and ops docs (incident response, DR/BCP) in full"
    over: "assuming Enterprise-level detail by default, or thinning Standard/Enterprise docs down to PoC-level prose"
    because: "guessing Enterprise weight for a small project wastes effort that should go into the requirement-to-test trace, while under-detailing an audited project leaves the audit/ops trail undiscoverable later"
  - when: "Writing a functional or non-functional requirement that contains 'and' or 'or' joining two distinct behaviours"
    choose: "split it into two requirement IDs, each a single verifiable sentence"
    over: "keeping the compound sentence under one ID because the behaviours are related"
    because: "one requirement ID must map to one test case; a compound requirement cannot be traced 1:1 to a single test and breaks the traceability the ID exists to guarantee"
  - when: "A decision is made about architecture, technology choice, or a scope tradeoff — including which parts of the work to delegate to an AI agent"
    choose: "record it as an ADR (`docs/adr/ADR-NNN-*.md`) with a one-line entry in the PLAN decision log, even for the AI-delegation boundary itself"
    over: "leaving the rationale only in chat, a code comment, or an unlinked design-doc paragraph"
    because: "architecture/tradeoff decisions and AI-delegation boundaries are exactly the class of decision a successor agent or auditor needs a durable, indexed record of — an ADR is the recording target this skill's map assigns to that class"
  - when: "Multiple tailoring options remain and there is a genuine cost/risk tradeoff between them"
    choose: "present the options with their tradeoffs and a recommendation, and let the human decide; write the ADR once they choose"
    over: "picking silently, or presenting an option that would destroy traceability (e.g. dropping requirement IDs in favour of free prose)"
    because: "the final rule in this judgement is that ambiguous tradeoffs are escalated, not resolved unilaterally, and that any traceability-destroying option is never on the table to begin with"
---

# design tailoring and granularity

How to decide **which** design documents a project needs, **how much detail**
each one gets, and **where** the resulting decision is recorded. This is a
judgement skill for scoping the design-doc set itself — it runs before
[[design-doc]] or [[documentation-and-adrs]] decide how a doc that has already
been scoped is written and frozen.

## When to load this skill

- Starting a new project, PLAN family, or Add-feature slice and no design-doc
  set has been scoped yet.
- Someone asks "which design docs does this need?" or "how far should this go?".
- A design-doc coverage check (or a `ut-tdd doctor` gap report) shows a topic
  marked `na` and it is unclear whether that is a real structural absence or a
  deferred decision in disguise.
- A requirement is being drafted and it is unclear whether it should be one ID
  or several.
- A decision needs to be filed and it is unclear whether the target is an ADR,
  the glossary, a standards doc, or the risk/debt register.

## Step 1: determine the project's nature first

Before scoping any doc, establish: scale (PoC / Standard / Enterprise),
platform (web / mobile / desktop / CLI / API service), and constraints (audit
exposure, PII, multi-tenancy, external integrations). If any of these is
unknown, ask — do not default to Enterprise-weight scoping on the assumption
that more detail is always safer. Guessing heavy adds process cost with no
matching risk to justify it; guessing light on a genuinely regulated project
leaves an audit trail undiscoverable later.

## Step 2: todo vs na — the only valid `na` condition

A design-doc topic (or a requirement, or a catalog entry) may be marked `na`
**only when the concern is structurally absent from the project** — e.g. a
single-tenant internal tool has no tenant-lifecycle doc to write; a system with
no batch jobs has no batch-design doc to write.

`na` is **forbidden** when the concern exists but:

- it is "not decided yet", or
- it is "tedious to write up".

Both of these stay `todo`. The undecided part goes into the risk register /
debt register (see [[debt-register]] for the PLAN-linked TTL discipline) or
the doc's own TBD section — never left as a dangling, unlinked `TBD`.

**Changing a topic's status to `na` purely to make a coverage gate turn green
is forbidden.** This is a false-green by relabeling, not a real resolution of
the concern.

## Step 3: the two self-questions

When it is unclear whether a topic needs its own doc:

1. **Incident/audit/handover test** — would someone be stuck without this
   information during an incident, an audit, or a session handover
   ([[requirements-handover]])? If yes, it is `todo`.
2. **Authoritative-source test** — is the authoritative source for this
   information already recorded elsewhere (e.g. the glossary, an existing
   design doc)? If yes, mark this location `na` and reference the existing
   source instead of duplicating it. Duplicate definitions drift from the
   source over time and become a downstream inconsistency, not a convenience.

## Step 4: granularity per project scale

| Scale | What the docs must contain |
|---|---|
| PoC | What is being validated and what counts as success. No detailed design, no ops design. (See [[poc]] for the S0-S4 mechanics once this scope is set.) |
| Standard | Requirements are ID-ed and traced to tests. Detailed design covers the module list and key logic; decision tables only where branching is genuinely complex. |
| Enterprise | Everything in Standard, plus audit-facing docs (security, privacy, controls mapping) and ops-facing docs (incident response, DR/BCP) written in full — these are not the docs to thin out under time pressure. |

**One requirement ID = one verifiable sentence.** A requirement joined by
"and"/"or" across two distinct behaviours must be split into separate IDs,
because one ID must trace 1:1 to one test case.

## Step 5: where the decision gets recorded

| What was decided | Record it here |
|---|---|
| Architecture, technology choice, or a decision with a cost/risk tradeoff | `docs/adr/ADR-NNN-*.md`, plus a one-line entry in the PLAN decision log (see [[documentation-and-adrs]] for ADR procedure) |
| A requirement itself | The requirements doc (F-/NF- IDs) plus the requirements ledger |
| A term or data-item definition | `docs/design/L0-glossary.md` — other docs reference it; never redefine it locally |
| Naming or coding conventions | The project's standards/conventions doc |
| An open issue or unresolved risk | The risk register / debt register ([[debt-register]]) — never a dangling `TBD` with no owner |
| The write/don't-write tailoring decision itself | This doc's own tailoring note (the artefact this skill governs) |

## AI-project additions

Projects that use an AI implementation agent add two more `todo` topics:

- **Agent design** — the prompt, tool access, and permission boundary the
  agent operates under.
- **AI-output verification design** — how the agent's output is checked
  before it is trusted (spec-to-test traceability, review gates).

**"What to delegate to the AI agent" is itself an architecture decision and
gets its own ADR** (e.g. "test generation is AI, acceptance judgement is
human") — it is not implicit in the agent-design doc.

## Final rule: escalate genuine tradeoffs, never offer a traceability-destroying option

When multiple tailoring choices remain and there is a real cost/risk tradeoff
between them, do not decide silently: present the options, the tradeoffs, and
a recommendation, and let the human choose. Once chosen, write the ADR
immediately. An option that would destroy traceability — for example,
retiring requirement IDs in favour of free-text prose — is never presented as
a valid choice in the first place.

## Boundary with existing skills

- **[[design-tailoring-and-granularity]] (this skill)** decides *which* docs
  a project needs, *how much detail* each gets, and *where* a given kind of
  decision is recorded. It runs first, before any doc is drafted.
- **[[documentation-and-adrs]]** governs how an *already-scoped* design doc or
  ADR is structured, written, and passed through the freeze readability check.
  It assumes tailoring has already decided the doc belongs in the set.
- **[[design-doc]]** governs diagram sourcing (Mermaid vs D2) and diagram
  obligations once a doc's scope and granularity are already fixed.
- **[[planning-and-task-breakdown]]** governs how a scoped requirement is
  decomposed into PLANs and schedule steps — a downstream step from the
  granularity decisions made here.

## Anti-patterns

- Marking a structurally-present concern `na` because a decision hasn't been
  made yet, or because writing it up is tedious — both must stay `todo`.
- Flipping a coverage-gate topic to `na` purely to turn the gate green.
- Writing a compound requirement ("X and Y") under a single ID instead of
  splitting it — breaks the 1:1 requirement-to-test trace.
- Redefining a term locally in a design doc instead of referencing the L0
  glossary — causes definition drift.
- Deciding a genuine cost/risk tradeoff unilaterally instead of presenting
  options + a recommendation to the human.
- Presenting an option that drops requirement IDs or otherwise breaks
  traceability as if it were a legitimate tailoring choice.
