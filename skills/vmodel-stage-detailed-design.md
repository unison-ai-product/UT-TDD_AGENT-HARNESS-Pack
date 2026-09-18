---
schema_version: skill.v1
name: vmodel-stage-detailed-design
skill_type: design-contract
applies_to:
  layers:
    - L5
    - L6
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
decision_points:
  - when: "Discovery or Scrum S2 PoC-scale work is about to reach L5 before writing throwaway spike code."
    choose: "skip the L5 detailed design and decision tables entirely and write a single hypothesis note (what is being tested, what disproves it) plus scratch code"
    over: "producing full module-list, API-detail, and table-detail chapters for code that may be deleted at S4 decide"
    because: "a PoC's evidence value is the answer to the spike question, not documentation completeness; a full L5 for code with a pending delete/promote decision is sunk cost with no downstream reader before that decision is made."
  - when: "Standard-scale product work reaches L5 for a function with more than one interacting branching condition (the case the source logic-design doc reserves decision tables for)."
    choose: "author a decision table with every condition column, but restrict decision-table authorship to that branching subset"
    over: "describing the branching only in prose bullets, or building a decision table for every branch including single-condition trivial ones"
    because: "decision tables exist for combinatorial coverage of complex branching; trivial single-condition branches do not need the table's overhead, and complex multi-condition branching cannot be safely reasoned about, or reviewed, in prose alone."
  - when: "Enterprise-scale work (multi-tenant, billing, compliance-sensitive, or otherwise high blast-radius) reaches L5."
    choose: "populate every applicable L5 chapter (functional detail, API detail, table/physical detail, screen detail, batch detail where batches exist) plus decision tables for every non-trivial branch, and require the paired L6 unit-test design, test plan, and verification design to be fully populated (verification matrix, coverage criteria, risk-based allocation, entry/exit criteria) before pair-freeze"
    over: "trimming any of these chapters for speed because the PoC/Standard paths trim them"
    because: "the scale-conditional trim that is legitimate at PoC or Standard is not legitimate once blast radius is high — the same chapters that are optional at smaller scale are what let a reviewer and a machine gate catch a tenant-isolation or billing defect before it reaches L7."
  - when: "The module or PLAN under L5 detailed design has no batch/async processing at all."
    choose: "omit the batch design chapter entirely"
    over: "filling in a placeholder or 'N/A' batch design chapter to make the document set look complete"
    because: "the batch design chapter exists specifically to detail BT-xxx jobs already declared in the basic design; a module with zero async jobs has nothing for that chapter to detail, and a placeholder row is exactly the false-completeness a doctor-style completeness check should not be satisfied by."
  - when: "Writing the input/output/check table for an adopted L5 function."
    choose: "include an explicit row for each abnormal/error path (invalid input, boundary violation, cross-tenant reference) with its rejection behaviour and message code"
    over: "recording only the happy-path input, processing, and output rows"
    because: "error paths are the most commonly blank cell in this table in practice, and an L5 with no explicit error-path row leaves the paired L6 unit-test design with nothing to trace an abnormal-case test against — the gap surfaces late, as an untraceable test or an untested error path, instead of at design time."
  - when: "Authoring the L6 unit-test design's test case list during this (shift-left) stage."
    choose: "give every test-case row an explicit trace-from entry naming the exact L5 item (function ID, API ID, common-part ID) it verifies"
    over: "writing descriptive test-case titles without a trace field and deferring the link to whenever the test is executed"
    because: "unit-test design case IDs are machine-checked data that must declare their origin; a test case written without a trace at design time is precisely the orphaned-test gap that traceability tooling exists to catch, and catching it here is far cheaper than catching it after L7 implementation has already been built against it."
  - when: "Authoring the verification design's verification matrix for a given requirement (functional or non-functional)."
    choose: "assign the requirement a method chosen by its nature — test-execution for behavioural requirements, analysis (or analysis+test) for requirements whose target is a computed estimate such as a performance SLO, inspection for structural/static properties, demonstration for requirements only confirmable in a live environment"
    over: "assuming every requirement is verified purely by running a test"
    because: "the verification design's own method catalog treats test-execution as one of four methods, not the only one; forcing a performance-class requirement into 'test only' leaves it formally test-planned but not actually verifiable until an environment exists that can produce the load — an analysis pass is what makes it verifiable before implementation exists."
  - when: "A PLAN whose scope touches L5 is at the pair-freeze gate."
    choose: "block pair-freeze until L5 (its adopted chapters), the paired L6 unit-test design, and — where the PLAN's requirement needs it — the corresponding L8 GWT scenario or L9 verification-matrix row all exist and resolve"
    over: "treating L5 completion alone as sufficient on the reasoning that 'the tests will be written during L7 implementation'"
    because: "this stage's own shift-left declaration pairs test design with descending design (L4-L5), not with L7 implementation; deferring test-design authorship to implementation time abandons the shift-left this stage exists to enforce and reproduces the exact anti-pattern spec-driven-development already forbids (spec/test written after the fact to justify what was built)."
---

# vmodel stage detailed design

What the detailed-design stage (L5, paired with L6 unit-test design) must
produce and verify before a PLAN can cross pair-freeze into implementation.
This stage is where the V-model's descending design side meets its own
shift-left test-design obligation: the unit-test design, the overall test
plan, and the verification design are all **authored here**, even though
they are not **executed** until later stages (L8 unit-test execution and
onward). This skill governs the stage's required output and exit criteria —
not the thinking techniques used to produce good test cases or good code,
which belong to other skills (see Boundary section).

## When to load this skill

- Authoring or reviewing an L5 detailed design document (functional detail,
  API detail, table/physical detail, screen detail, batch detail).
- Authoring or reviewing the L6 unit-test design, the overall test plan, or
  the verification design that pair with an L5 doc.
- Deciding whether a decision table, batch design chapter, or full
  verification-design chapter set is warranted for a given PLAN's scale.
- A PLAN is approaching pair-freeze and its L5/L6/test-plan/verification-design
  completeness needs a structured check.

## What detailed design (L5) must fix

L5 takes each basic-design element (function ID, API ID, table ID, screen ID,
batch ID) forward into implementable detail. Each adopted chapter fixes:

- **Module / functional detail** — for each function ID: the trace source
  (basic design + requirement), the processing flow as a numbered sequence,
  and an input/output/check table that names every input, its check/
  transformation, and its output — **including the abnormal path**, not only
  the happy path (see decision point above).
- **API detail** — for each API ID: request shape (field, type, required,
  description), and response/error shape (status code, meaning, message
  code) covering both success and the documented error codes (400/401/403/
  429-class conditions), not success alone.
- **Table detail (physical)** — for each table ID: column definitions (name,
  type, length, not-null, PK/FK), and any composite index the access pattern
  requires (e.g. a `(tenant_id, project_id, status)` index for a
  tenant-scoped query). Multi-tenant tables must show the tenant-scoping
  column and note where it is enforced.
- **Screen detail** — for each screen ID: the field list (item, type,
  required, check/behaviour) and the event list (event, processing, which
  API it calls). Only produce this chapter for a PLAN that touches UI.
- **Batch/async detail** — only where the basic design already declares an
  async job (a BT-xxx ID). For each: trigger condition, processing steps as
  a numbered sequence, and an explicit abnormal-handling table (failure mode,
  handling, who is notified). A module with no async job has no batch
  chapter to write — do not manufacture a placeholder one.
- **Decision tables — only where branching is complex.** Use a decision
  table (all condition columns × rule columns × resulting actions) only for
  business rules with more than one interacting condition. Simple
  single-condition branches stay in prose or a plain rule list; forcing every
  branch into decision-table format adds format overhead without adding
  coverage value.
- **Common / exception / message catalog** — shared components (e.g.
  tenant-scope enforcement, RBAC guard, idempotency handling, audit logging)
  and the message-ID catalog (error/info/warning) that L5 chapters reference
  by ID rather than restating inline.

## Shift-left test design authored (not executed) at this stage

Three artifacts are **written** during this stage even though their
**execution** happens later in the V-model's ascending side:

1. **L6 unit-test design** — one test case per L5 output/error condition,
   each row carrying a trace-from reference to the exact L5 item it
   verifies. Test-case IDs are declared as data (machine-checkable), not
   only as document prose. Executed later as L8 unit-test execution.
2. **Overall test plan** — the full V-model test strategy (which test level
   pairs with which design level, environment/data plan, schedule, entry/
   exit criteria per level, defect-severity definitions). Authored once per
   product/PLAN scope at this stage; execution and result reporting happen
   across the later test levels.
3. **Verification design** — the verification matrix (requirement → method →
   test level → technique → case ID), the test-design technique catalog
   (equivalence partitioning, boundary analysis, decision table, state
   transition, pairwise, use-case/exploratory), coverage criteria, and
   risk-based test allocation (dig deep on tenant boundaries, billing,
   authorization; go shallow on framework-guaranteed CRUD). Verification is
   not only "run a test" — inspection, analysis, and demonstration are valid
   methods for requirements a test-execution cannot directly confirm before
   an environment exists (e.g. a performance SLO needs an analytical
   estimate at this stage).

The V-model correspondence this stage sits inside: unit test (L8) verifies
detailed design (L5); integration test (L9) verifies basic design (L4);
system test (L10) verifies requirements (L3); acceptance test (L11) verifies
requirements/proposal (L2/L1). The descending design side and the ascending
test side are meant to be authored as pairs at the same time this stage
runs, not written independently.

## Common omissions

- **Error paths left undesigned.** The input/output/check table records only
  the happy path; no row states what happens on invalid input, and no
  message ID is assigned.
- **Decision-table blanks.** A rule column left empty ("undecided") instead
  of an explicit action — an undecided combination is a design gap, not a
  cell to leave blank for later.
- **Batch abnormal-handling table skipped** while the happy-path processing
  steps are fully written — partial-failure and retry/checkpoint behaviour
  is exactly where compensation-logic bugs surface.
- **Unit-test design rows with no trace-from** — a test case with a
  descriptive title but no link back to the L5 item it verifies, making the
  case impossible to machine-check for orphaning.
- **Verification matrix rows assuming test-execution is the only method** —
  particularly for non-functional requirements (performance, capacity) that
  need an analysis pass to be verifiable before an environment exists.
- **Physical table detail missing the composite index** a stated access
  pattern (tenant + status filter, etc.) actually requires.

## Stage exit criteria (before pair-freeze)

- [ ] L5 exists with all chapters the PLAN's scope adopts; no adopted
  chapter has a blank required row.
- [ ] Every input/output/check table entry has an explicit error-path row
  where the function accepts untrusted input.
- [ ] Decision tables exist for every business rule with more than one
  interacting condition; no rule-table cell is left undecided.
- [ ] Batch detail chapter exists only where async jobs are declared, and its
  abnormal-handling table is filled.
- [ ] L6 unit-test design exists with at least one case per L5 output/error
  condition, each case carrying a trace-from reference.
- [ ] The overall test plan's V-model strategy table and entry/exit criteria
  are filled for every test level this PLAN's scope reaches.
- [ ] The verification design's verification matrix covers every requirement
  this PLAN traces to, with a method chosen by the requirement's nature
  (not defaulted to "test" for every row).
- [ ] `ut-tdd doctor` / `ut-tdd plan lint` resolve all L5↔L6 pairing links.

## Boundary with existing skills

- **`spec-driven-development`** owns the general spec-first contract (five
  required sections, GWT at L8, the pair-freeze gate mechanics themselves).
  This skill is the stage-specific elaboration of *what an L5 doc's
  chapters must contain* (module list, decision tables, batch design) and
  *what gets authored alongside it as shift-left test design*. Load
  `spec-driven-development` for the cross-layer contract and freeze-gate
  procedure; load this skill for the L5-specific chapter content and its
  common omissions.
- **`test-breakage-thinking`** owns the *quality of ideation* inside a test
  case — which breakage scenarios (zero/one/many/boundary, permission
  boundary, failure-mode) actually earn a place in the L6 unit-test design
  this stage produces. This skill tells you the L6 doc must exist, must
  trace to L5, and must cover every output/error condition; it does not
  tell you how to think up the individual test scenarios inside each row —
  that is `test-breakage-thinking`'s job. Load both together when authoring
  L6 test-case content.
- **`design-principles-pillars`** owns the seven design pillars and the
  domain-implementation / class-method norms that later govern L7
  implementation. This skill's decision tables and functional-detail
  chapters are upstream inputs to that later implementation work, but this
  skill does not itself judge value-object shape or method structure — see
  `vmodel-stage-implementation-unit` and `design-principles-pillars` for
  that.
- **`test-driven-development`** and **`refactoring`** govern the L6→L7→L8
  Red-Green-Refactor cycle and behaviour-invariant restructuring. Those
  begin only after this stage's L5/L6 pairing exists and pair-freeze has
  passed; this skill is entirely upstream of them.

## Anti-patterns

- Filling a decision table for a trivial single-condition branch "to be
  thorough" — this adds format overhead without adding coverage and
  obscures where decision tables are actually load-bearing.
- Writing a batch design chapter with placeholder rows for a module that has
  no async processing, purely so the document set "looks complete."
- Treating the test plan and verification design as post-hoc documentation
  written after L7 implementation exists — both are shift-left artifacts;
  authoring them late defeats the purpose this stage exists to serve.
- Leaving a verification-matrix row defaulted to "test" for a requirement
  (e.g. a performance SLO) that cannot actually be confirmed by test
  execution until an environment exists — this hides the requirement's real
  unverifiable status behind a plausible-looking row.
- Recording only happy-path rows in the input/output/check table and
  treating "no error row" as implicitly meaning "no error handling needed."
