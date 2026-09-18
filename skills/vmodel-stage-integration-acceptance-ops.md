---
schema_version: skill.v1
name: vmodel-stage-integration-acceptance-ops
skill_type: verification
applies_to:
  layers:
    - L8
    - L9
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Reverse
decision_points:
  - when: "A module-boundary or external-service handoff (SSO, payment webhook, public API) is implemented and its basic design (L4-level connection spec) exists."
    choose: "verify it at the integration-test rung: exercise the real cross-module/cross-service call chain against the basic-design connection spec"
    over: "treating passing unit tests as sufficient evidence the modules talk to each other correctly"
    because: "unit tests exercise a single module's internal correctness; only an integration test exercises the interface/data-handoff contract two modules were designed to share, and that contract is exactly what basic design specifies and unit tests cannot see."
  - when: "All integration tests for a release candidate are green and the question is whether the release satisfies the frozen requirements (F-xxx/NF-xxx) as a whole."
    choose: "run a system test against a production-equivalent, multi-tenant-representative staging environment covering business scenarios, tenant isolation, and non-functional targets (performance, availability, security) together"
    over: "declaring requirements satisfied because each individual integration test passed"
    because: "green integration tests only prove pairs of modules cooperate; requirement satisfaction is a system-level property (an end-to-end business scenario, cross-tenant isolation under load, NF targets under production-like conditions) that no single integration test observes."
  - when: "System tests are green and the team wants to claim the product delivers the value/demand that motivated the project (R-xxx business requirements, KPIs)."
    choose: "run acceptance tests derived from the original demand doc (企画書/要求定義) and BDD/Gherkin scenarios traced from Example Mapping, with the business/customer side judging pass/fail"
    over: "letting the engineering team's system-test sign-off stand in for acceptance"
    because: "system test verifies the frozen requirements were built correctly; acceptance test verifies those requirements were the right ones — a different question that only the demand-holder (business/customer) is positioned to answer, and BDD scenarios are the traceable, executable form of that judgement."
  - when: "Acceptance tests have passed and the release is about to ship, but no operational test has been run."
    choose: "treat this as an incomplete ascent: schedule and pass an operational test (monitoring/alerting fires correctly, backup/restore RTO/RPO is real not desk-checked, runbooks execute, rollback works) before calling the release operationally ready"
    over: "shipping on acceptance-test sign-off alone because 'the product does what customers want'"
    because: "acceptance test verifies the product against customer demand; it says nothing about whether the organisation can run, observe, recover, and roll back the product in production — that is the charter-level concern operational test exists to close, and skipping it is a named common omission, not a shortcut."
  - when: "A Go/No-Go release judgement is being made between acceptance test sign-off and operational readiness."
    choose: "run it as an explicit checklist gate (structural: trace gates green; execution: declared tests pass with evidence; substance: adversarial review flags at zero; security: exit criteria met; quality-characteristic: ISO/IEC 25010 diagnosis; ops readiness: runbook/rollback/alerting updated) and default to No-Go when any row is ambiguous"
    over: "treating 'acceptance tests passed' as an implicit Go decision"
    because: "the QA/Go-No-Go checklist is explicitly a cross-cutting diagnosis distinct from 'did the planned tests run' — it exists precisely because acceptance-test-green does not by itself certify ops readiness, security exit criteria, or non-functional quality, and ambiguous rows must fail closed (the same safe-side default as defence-in-depth)."
  - when: "An acceptance criterion or BDD scenario exists but cannot be traced back to a business demand ID (R-xxx) or a requirement ID (F-xxx/NF-xxx)."
    choose: "flag it as a design gap and route it back to the demand/requirement doc before accepting it as a valid acceptance test"
    over: "keeping the scenario because it exercises plausible-looking behaviour"
    because: "every AT/FT entry in the acceptance design is required to declare traces_from into R-xxx or F-xxx/NF-xxx; an untraceable acceptance criterion cannot prove the original demand is met and silently substitutes engineer judgement for customer judgement — the exact common omission this rung exists to prevent."
  - when: "A PoC-scale project reaches the point where the ascent ladder (integration -> system -> acceptance -> operational) would normally run."
    choose: "substitute the PoC-verification design (single spike question, done condition) for the full four-rung ladder, and skip system/acceptance/operational test entirely"
    over: "forcing all four rungs on throwaway PoC code"
    because: "the ascent ladder verifies frozen requirements, original demand, and production operability — none of which exist yet for a PoC by design; running the full ladder on spike code adds process cost with no corresponding artefact to verify against."
  - when: "Writing the integration/system/acceptance test design docs themselves, before any test in them has been executed."
    choose: "treat this authoring step as shift-left design work that must already be complete — traced to L4 basic design (integration), L3 requirements (system), and L2 demand/BDD scenarios (acceptance) — before the corresponding implementation is built, not written after the fact to match what shipped"
    over: "writing the test design retroactively once the implementation exists, to document what was already tested informally"
    because: "each of these test-design docs declares its own upstream trace-from requirement and a machine-checked done_when gate; authoring them after the fact defeats the descent-side (left-side) design signal the ascent rungs are supposed to verify against, turning verification into rubber-stamping."
---

# vmodel stage: integration / system / acceptance / operational test

The ascent (right side of the V-model, L9-L12 in the V-level numbering used by
the source design corpus) is a ladder of four rungs, each verifying a
different left-side artefact and answering a different question. This skill
distills what each rung checks, what its test-design doc must contain, and
where the ladder commonly breaks.

## When to load this skill

- A PLAN is at trace-freeze or review and integration, system, or acceptance
  test design/execution is in scope.
- Deciding whether a release is ready to ship and no explicit Go/No-Go
  checklist has been run yet.
- An acceptance criterion or BDD scenario shows up with no traceable upstream
  ID.
- Operational test is being skipped or deferred and it is unclear whether that
  is a legitimate scope decision or a gap.
- Scoping test-design work for a PoC and deciding how much of the ladder
  applies.

## The four rungs: what each one verifies

| Rung | Verifies (left-side pairing) | Central question |
|---|---|---|
| Integration test | Basic design (module/external-service connection spec) | Do the pieces I built talk to each other the way basic design says they should? |
| System test | Frozen requirements (F-xxx functional, NF-xxx non-functional) | Does the whole system, end to end, do what was specified? |
| Acceptance test | Original demand (企画/要求定義, R-xxx, KPIs) via BDD/acceptance criteria | Was the thing we built the *right* thing to build? |
| Operational test | The project charter itself (can the org run this in production) | Can we actually operate, observe, recover, and roll this back once it's live? |

Each rung verifies a different upstream artefact. A rung passing does not
imply the rung above it would also pass — system-green says nothing about
acceptance, and acceptance-green says nothing about operational readiness.
Treat "all rungs passed" as a conjunction that must be checked explicitly, not
inferred from the top-most rung alone.

## Rung 1: integration test

- **Object under test**: cross-module and cross-external-service data/control
  handoffs (SSO/OIDC login, payment webhook flow, outbound webhook delivery,
  public API CRUD) — anything basic design specifies as a connection between
  two things.
- **Must-have items in the test-design doc**: a test-case table with test ID,
  category, verification content/procedure, expected result, and an explicit
  `traces_from` column pointing back to the basic-design function/interface
  IDs it exercises; a pass/fail bar (all cases match expected result, no
  unresolved severe/high defects, non-functional interconnect targets like SLA
  and tenant separation are met at this scope); an environment section
  (production-equivalent multi-tenant staging, masked multi-tenant data).
- **Common omission**: an integration test case with no `traces_from` back to
  a basic-design ID. Treat that as a design gap, not a valid test — the same
  discipline [[spec-driven-development]] applies to L8 GWT blocks.

## Rung 2: system test

- **Object under test**: the system as a whole against the frozen requirements
  set (functional F-xxx and non-functional NF-xxx together), including
  business-scenario walkthroughs, multi-tenant isolation under adversarial
  access attempts, and non-functional targets (latency, availability/SLO,
  security) measured under load, not asserted in prose.
- **Must-have items**: business-scenario cases, a dedicated multi-tenant
  isolation case ("can tenant A reach tenant B's data"), and one case per
  non-functional target category (performance/load, availability/failure
  injection, security), each with `traces_from` into F-xxx/NF-xxx.
- **Common omission**: NF targets checked only by inspection ("should be
  fast") instead of measured against a stated threshold (e.g. p95 < 300ms)
  under representative load.

## Rung 3: acceptance test

- **Object under test**: the original business demand and KPIs (from the
  charter/demand docs, R-xxx), not the requirements doc — a requirement can be
  built correctly and still fail to satisfy the demand it was derived from.
- **Must-have items**: acceptance-test cases each tracing to an R-xxx demand
  ID, business-side (not engineering-side) pass/fail judgement, and a BDD
  layer underneath: Example Mapping (story/rule/example/question) that
  converts fuzzy demand into concrete examples, then Given-When-Then Gherkin
  scenarios written in the project's ubiquitous/domain language, each Feature
  ID tracing to an AT ID. Scenario Outlines cover the parametrised edge cases
  (e.g. plan-tier limits) as a data table rather than duplicated prose
  scenarios.
- **Who judges**: acceptance test is explicitly judged by the business/
  customer side, not by the team that built the system — this is what
  distinguishes it from system test and is the reason it cannot be skipped
  even when system test is fully green.
- **Common omission**: an acceptance criterion or Gherkin scenario with no
  traceable R-xxx or F-xxx/NF-xxx origin (a plausible-looking scenario nobody
  actually asked for), and unresolved questions from Example Mapping (the
  "red" cards) left unanswered instead of escalated before the scenario is
  frozen.

## Rung 4: operational test

- **Object under test**: the charter itself — can the organisation actually
  run this system in production, not just "does the software behave
  correctly." This covers: monitoring/alerting fires on the SLIs it's
  supposed to (multi-window burn-rate alerts, not just threshold crossings);
  backup/restore RTO/RPO verified by an actual restore rehearsal, not a
  desk-check (rehearsal must be recent — a stale rehearsal is treated as
  evidence of drift, not evidence of readiness); incident runbooks execute as
  written; release/rollback (canary or blue-green, immutable rollback,
  expand-migrate-contract for irreversible DB migrations) actually works;
  checkpoint/resume and idempotency hold for interruptible long-running
  processes (batch, migration, webhook/payment processing, AI-agent
  execution) — every such process must persist a resumption point and dedupe
  key so a mid-run interruption cannot double-apply an effect.
- **Must-have items**: a monitoring/SLI table with thresholds, an error-budget
  policy (what release behaviour changes as the budget depletes), a
  backup/restore table with RPO/RTO and rehearsal cadence, a severity/
  escalation table (SEV1-3) with initial response times, a runbook per known
  failure mode, and — for anything with an interruption risk — a
  checkpoint/journal record schema (run_id, started/ended, processed/total,
  last_checkpoint, status, tenant_id) plus an idempotency-key strategy.
- **Common omission**: operational test skipped entirely because acceptance
  test passed and the release "works" — this is the single most common
  omission on this rung. A product can satisfy every business demand and
  still be un-operable (no rehearsed restore, no working rollback, no alert
  wired to the SLI that actually predicts an incident).

## The Go/No-Go judgement (between acceptance test and operational test)

Before a release ships, run an explicit cross-cutting diagnosis — this is
distinct from "did the planned tests run" and closes the gap the four rungs
leave between "the tests I wrote passed" and "this is releasable":

1. **Structural** — trace network intact, all applicable gates green for this
   release's scope/profile.
2. **Execution** — every declared test for in-scope requirements actually
   passed, with evidence, and no drift between the declared test ledger and
   what actually ran.
3. **Substance** — adversarial/independent review flags at zero (a `todo`
   test existing is not the same as a test that meaningfully exercises the
   requirement).
4. **Security** — exit criteria met (no unresolved Critical/High findings).
5. **Quality characteristics** — an ISO/IEC 25010-style diagnosis
   (functional suitability, performance, compatibility, usability,
   reliability, security, maintainability, portability) with each row backed
   by a measurable statement, not "fast enough" prose.
6. **Ops readiness** — runbooks, rollback procedure, and monitoring alerts are
   updated for what is actually shipping in this release.

**Default to No-Go when a row is ambiguous.** Conditional Go is only valid
when a named judge explicitly records risk acceptance in the risk/debt
register — silence or "probably fine" is not a recorded acceptance.

## Shift-left dependency: what must already exist before this ascent runs

The ascent rungs verify artefacts that must already be frozen on the descent
side. Before integration/system/acceptance test execution can meaningfully
start:

- Basic design (L4) must be frozen — integration test has nothing to trace to
  otherwise.
- Requirements (L3, F-xxx/NF-xxx) must be frozen — system test has nothing to
  trace to otherwise.
- The demand/charter doc (L2, R-xxx) and BDD Example Mapping/Gherkin scenarios
  must exist — acceptance test has nothing to trace to otherwise, and writing
  Gherkin scenarios *after* the implementation exists (to match what shipped)
  defeats the point: they exist to let the business side judge the build
  against demand, not to rubber-stamp it.

What is executed *at* this stage (not shift-left) is the actual test run: the
staging/production-equivalent environment setup, the executed test cases, the
defect log, and the sign-off record. The test-design docs themselves
(structure, traces_from, pass/fail bar) are shift-left artefacts authored
before or alongside implementation, exactly like L6 unit-test design per
[[spec-driven-development]].

## Scale-conditional: PoC

A PoC-scale project does not run the full four-rung ladder. Frozen
requirements, an original-demand doc distinct from the spike question, and a
production charter typically do not exist yet for a PoC by design — see
[[product-profile-tailoring]] for how the PoC profile scopes verification
down to PoC-verification design (spike question + done condition) plus
AI-verification, and [[poc]] for the S0-S4 mechanics that own this substitute
path.

## Boundary with existing skills

- **[[spec-driven-development]]** owns the spec-to-test contract and the L8
  GWT-block traceability discipline in general; this skill is the specific
  application of that discipline to the L9-L12 ascent ladder and adds the
  four-rung sequencing and Go/No-Go judgement spec-driven-development does not
  cover.
- **[[testing.md|testing]]** owns unit/CI test execution mechanics (runner
  choice, `npm run test`, coverage tooling); this skill owns the higher-level
  test *levels* (integration/system/acceptance/operational) and what each one
  verifies, not how any individual test is run.
- **[[browser-testing-and-screen-verification.md|browser-testing-and-screen-verification]]**
  owns UI-specific verification (component/E2E/visual-regression/cross-
  browser/a11y) for screen-facing PLANs; this skill's acceptance-rung BDD
  scenarios may be *executed* via browser automation, but the screen-specific
  tooling and scope-gate decisions live in that skill, not here.
- **[[verification.md|verification]]** owns the general verification-design
  matrix and technique catalog (ISTQB-style test technique selection, test
  data design) that underlies test-case authoring at every rung; this skill
  assumes that matrix exists and focuses on what is unique to the four ascent
  rungs and the Go/No-Go gate.
- **[[gate-planning.md|gate-planning]]** owns the general question of "is this
  unit of work complete" at PLAN/task granularity; the Go/No-Go checklist here
  is a release-level instance of that same discipline, scoped specifically to
  the acceptance-to-operational handoff.

## Anti-patterns

- Declaring a release ready because acceptance tests passed, without running
  or scheduling operational test.
- An integration/system/acceptance test case with no `traces_from` into its
  left-side origin ID.
- Writing BDD/Gherkin acceptance scenarios after implementation to match what
  shipped, rather than before, from the demand doc.
- Treating engineering sign-off (system test green) as a substitute for
  business/customer acceptance judgement.
- Checking a non-functional target ("fast enough", "reliable") by inspection
  instead of against a stated, measured threshold.
- Marking Go on an ambiguous Go/No-Go row instead of defaulting to No-Go and
  recording risk acceptance explicitly.
- Verifying backup/restore RTO/RPO by desk-check instead of an actual,
  recent restore rehearsal.
