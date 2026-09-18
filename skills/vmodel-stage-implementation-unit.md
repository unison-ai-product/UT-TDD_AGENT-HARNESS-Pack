---
schema_version: skill.v1
name: vmodel-stage-implementation-unit
skill_type: design-contract
applies_to:
  layers:
    - L6
    - L7
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Refactor
decision_points:
  - when: "Discovery or Scrum S2 PoC-scale spike code is being written to answer a hypothesis, and a domain rule (e.g. a non-negative amount) is involved."
    choose: "write plain functions or a lightweight object without the complete-constructor / create()-reconstruct() factory split, and one throwaway test confirming the spike question"
    over: "building the full private-constructor value-object pattern for a class that may be deleted or rewritten at S4 decide"
    because: "the complete-constructor and create/reconstruct split exist to protect an invariant across ongoing change; a spike with a pending delete/promote decision does not accrue that long-term benefit, and the ceremony cost is paid for nothing if the code is discarded."
  - when: "Standard or Enterprise-scale implementation reaches a class with four or more constructor parameters, or a value with a business invariant (a non-negative amount, an allowed-status set, a bounded seat count)."
    choose: "build it as a value object with a private constructor, exposed only through create() (full validation, for untrusted input) and reconstruct() (minimal validation, for trusted persisted state)"
    over: "validating the same invariant informally and separately at each call site (an API-boundary check here, another check there)"
    because: "invariants must be enforced in exactly one place; validating at multiple call sites both duplicates logic and leaves a second path — direct construction — that can still produce an invalid object, defeating the point of having a single source of truth for the rule."
  - when: "A branch condition or numeric threshold encodes a business decision (a plan limit, a rate, a rule someone may want to change without a release) and is about to be written directly into L7 source."
    choose: "route it to config or master data before writing the conditional, tracing the value's origin (requirement/decision ID) rather than leaving only a comment"
    over: "writing the value as an inline literal or if/else chain because it satisfies every case currently known"
    because: "the coding-standards hardcode ban and the class/method complexity cap both apply here: a business-decided branch hardcoded into source turns every future business change into a release event, and folding more cases into the same conditional chain is also what pushes a function's cyclomatic complexity toward the refactor threshold."
  - when: "A function feels overly complex during implementation, and a refactor step is being considered."
    choose: "check a concrete trigger first — cyclomatic complexity above ~15 per function, duplicate-code rate above ~5%, unit-test suite runtime crossing its budget, or a module with 2 of its last 3 changes causing a regression — before filing the refactor step"
    over: "refactoring on an unmeasured 'this looks messy' judgement in the middle of feature work"
    because: "refactor triggers in this stage are explicit, measured thresholds tied to a lint/duplication/CI-timing/change-failure signal, not a qualitative impression; refactoring without a measured trigger risks silently mixing structural change into feature work with no accountable threshold to point to later."
  - when: "A unit test that traces to an L5 decision-table rule or output condition passes on its very first run against L7 implementation, with no prior observed failure."
    choose: "treat it under the Red-first rule: the test must have been written and confirmed Red before the implementation existed, and an unexplained first-run pass must be investigated (vacuous assertion, or the behaviour already existed) before being accepted as verification of the L5 rule"
    over: "accepting a first-run green unit test at face value as evidence the L5 decision-table rule is satisfied"
    because: "this stage's apex-of-the-V obligation is the TDD closure between test implementation and implementation; a test that never went Red carries none of the design-signal value the closure exists to produce, no matter how correct the eventual assertion looks."
  - when: "A class/method design review during this stage finds a boolean flag argument, or an else-branch nesting the happy path, in code that currently passes its tests."
    choose: "reject it against the mechanical class/method checklist (flag argument → split method or use an enum/strategy; else-nesting → guard clause plus early return) before accepting the code as a correct implementation of the L5 spec"
    over: "accepting it because the tests pass and the code 'reads fine' on inspection"
    because: "the class/method design norms are written to be judged mechanically, independent of whether the current test suite happens to pass — a flag argument or nested happy path is a structural design defect in its own right, and passing tests do not certify structural conformance."
  - when: "L7 implementation is about to persist data produced or transformed by an AI/LLM output."
    choose: "route the AI output through JSON output → schema validation → domain factory (create()) → repository, treating the AI output as untrusted for the whole path"
    over: "letting the generating agent or its output call the repository/DB layer directly, reasoning that the schema already validated the JSON once"
    because: "the domain-implementation policy's AI-boundary rule requires validated-JSON → domain → repository as the one enforcement point; a direct DB write from AI output — even after schema validation — bypasses the invariant enforcement that only the domain factory actually performs."
  - when: "A PLAN reaches trace-freeze after L7 implementation and unit-test execution."
    choose: "block trace-freeze until the coding-standard CI gates (lint/format, unit test plus its coverage threshold, doc/ID-link validation, dependency and secret scanning) are all green, AND the executed unit-test results are checked to actually verify the paired L5 detailed-design items they trace to — not merely that tests exist and pass"
    over: "treating a green CI run alone as sufficient evidence the implementation satisfies the L5 spec"
    because: "the test plan pairs unit-test level explicitly against detailed design as its verification target; a green gate is structural governance, not substance, and accepting it as substance reproduces the coverage-is-not-verification-of-content failure this harness's own verification discipline exists to prevent."
---

# vmodel stage implementation unit

What the implementation / test-implementation / unit-test stage (the apex of
the V, L6 unit-test authoring meeting L7 implementation meeting L8 unit-test
execution) must respect and produce before a PLAN can cross trace-freeze.
This skill governs the stage's required conformance — coding standards, the
domain-implementation and class/method norms, the TDD closure at the apex,
what unit-test execution must actually verify, and when a measured refactor
trigger applies — not the general thinking techniques those obligations draw
on (see Boundary section).

## When to load this skill

- Crossing pair-freeze into L7 implementation for a Forward or Add-feature
  PLAN, or performing a Reverse back-fill.
- Writing or reviewing a value object, entity, or aggregate root during L7.
- A code review is checking class/method shape (argument count, control
  flow, error handling) against a mechanical rule set.
- Unit-test execution results are being evaluated as verification of an L5
  detailed-design item.
- A refactor is being considered mid-implementation and needs a trigger
  check before it is filed.
- An AI-agent-produced code path is about to persist domain data.

## What implementation must respect

**Coding standards and conventions** (applies across all L7 work):

- Formatter/Linter enforced in CI — not optional, not manually applied.
- One function, one responsibility; no magic numbers; meaningful names.
- Tenant scope enforced at the repository layer; raw queries that could
  cross a tenant boundary are disallowed, not merely discouraged.
- No merge without accompanying unit tests; a stated coverage threshold is
  a CI gate, not a suggestion.
- Structured (JSON) logs carrying a correlation ID and tenant ID; audited
  operations recorded separately from ordinary application logs.
- Error-code system: input errors, auth errors, business errors, and system
  errors each get a distinct code range and HTTP-status mapping — do not
  invent an ad hoc code outside the declared ranges.
- Conventional Commits, trunk-based or GitHub-Flow branching, PR review plus
  green CI required before merge.

**Domain-implementation policy** (value objects / aggregates), the substance
a class/method review checks for:

- **Complete constructor** — an object is built already satisfying every
  invariant; there is no half-valid intermediate state reachable.
- **Value objects are immutable, value-equal, self-validating** — no
  setters; the business rule lives on the type, not scattered through
  procedural validation calls.
- **Aggregate roots own consistency** — state changes go only through
  aggregate-internal methods; a nested entity is never mutated directly
  from outside its aggregate.
- **Generation vs. reconstruction are separate factories** — `create(...)`
  fully validates untrusted input (API/CLI/UI); `reconstruct(...)` performs
  minimal validation for state already trusted (DB rows, replayed events).
  Only the factories are public; the raw constructor stays private.
- **Boundary design** — everything outside the domain is received as an
  unvalidated input DTO, converted at the boundary via `create()`, and
  represented outward via a separate response DTO. Errors are aggregated as
  `Result<T, Violations>` — do not throw on the first violation found;
  exceptions are reserved for invariant violations, not expected input
  errors.

## Class and method design norms (mechanical, review-checkable)

**Control flow**: no `else` nesting the happy path — guard clause plus early
return instead. Cap branch/loop nesting at 2-3 levels. Positive conditions
over double negatives. Fail fast on an invalid state.

**Methods**: single responsibility, one abstraction level; ~20-30 lines
before extraction; cap arguments at ~3 (collapse into a value/parameter
object beyond that); no boolean flag arguments (split the method, or use an
enum/strategy); command-query separation; prefer purity, push I/O to the
boundary.

**Classes**: single responsibility; immutable by default, no setters;
composition over inheritance; minimal public surface (raw constructor
non-public, factory-only access); dependency direction points away from
DB/UI (dependency inversion).

**Null / error / exception**: never pass or return `null` — `Optional`, a
value object, or an empty collection instead. Expected/handleable input
errors return `Result<T, Violations>`; exceptions are reserved for invariant
violations or unrecoverable states. Errors are aggregated at the boundary,
not thrown on the first violation.

**Complexity / readability**: cyclomatic complexity ~10 or below per
function (a refactor-trigger threshold of ~15 is where this becomes a
tracked debt item, not merely a style note); no magic numbers; declarative
processing (`map`/`filter`/`reduce`) over manual loops where it expresses
intent; DRY routed to the shared-component set, not copy-pasted.

**Mechanical review checklist** (each item a cheap model can apply without
judgement): no `else` nesting the happy path; no nesting beyond 3 levels; no
method over ~3 arguments or with a boolean flag; no `null` returned or
accepted; no exception used for an expected input error; no setter or
mutable field on a value object; no side effect inside a query method (CQS
held); no bare magic number.

## The TDD closure at the apex

This stage is the apex of the V: test implementation and implementation
close the loop that L6 unit-test design opened during the shift-left
detailed-design stage. The closure obligation is Red-first — a test written
after its implementation, or a test that passes on its first run with no
prior observed failure, has not actually closed the loop even if its final
assertion is correct. Unit-test execution at this stage exists to verify the
paired **L5 detailed-design item** the test traces to (a decision-table rule,
an input/output/check row, a batch abnormal-handling row) — a green test run
is evidence about that specific traced item, not a general correctness
claim about the module.

## Refactoring triggers and metrics

A refactor step inside this stage is triggered by a measured threshold, not
a qualitative impression:

| Metric | Threshold | Measured by | On trigger |
|---|---|---|---|
| Cyclomatic complexity | >15 per function | lint (radon/eslint-class tool) | Register as tracked debt; schedule next cycle |
| Duplicate code rate | >5% | duplication scanner (jscpd-class tool) | Cross-check against the shared-component set for consolidation |
| Unit-test suite runtime | crosses its stated budget (e.g. >10 min) | CI timing | Plan test-suite split / fixture cleanup |
| Change-failure rate | 2 of the last 3 changes to a module caused a regression | issue/incident tracking | Immediate high-priority refactor target |

A refactor under one of these triggers still follows the general
Red-Green-Refactor discipline (regression fence first, one structural change
per commit, revert on Red) — this table only supplies the entry condition
that justifies opening a refactor step in the first place, distinct from
choosing to refactor because code "looks wrong."

## Must-have evidence

- CI gates green: lint/format, unit test plus its coverage threshold,
  doc/ID-link validation (no broken trace reference), dependency and secret
  scanning.
- Each executed unit test's result checked against the specific L5 item it
  traces to, not only against "the suite is green."
- Red-evidence commit (the failing test, committed standalone) present for
  every new test, per the TDD closure obligation.
- A refactor step, if taken during this stage, cites the measured trigger
  that justified it.
- Any AI-agent-produced persistence path shown to route through
  JSON → schema validation → domain factory → repository, not directly to
  the DB.

## Stage exit criteria (before trace-freeze)

- [ ] Coding-standard CI gates (lint/format, test+coverage, doc-link
  validation, dependency/secret scan) all green.
- [ ] Every new value object/entity follows the complete-constructor /
  create()-reconstruct() split with a private raw constructor.
- [ ] Class/method mechanical checklist passes (no flag arguments, no
  else-nested happy path, no null return/accept, no exception for expected
  input error, no bare magic number).
- [ ] Every new unit test has a Red-evidence commit and traces to an L5
  detailed-design item; no first-run-green test accepted without
  investigation.
- [ ] Any refactor step taken during this stage cites its measured trigger
  (complexity/duplication/runtime/change-failure).
- [ ] Any AI-agent-produced domain data confirmed to route through the
  validated-JSON → domain factory → repository path.
- [ ] `npm run typecheck && npm run lint && npm run test && ut-tdd doctor`
  green; `ut-tdd review --uncommitted` has no blocking finding.

## Boundary with existing skills

- **`test-driven-development`** owns the Red-Green-Refactor *cycle
  mechanics* (write the failing test, watch it fail, write minimum source,
  revert on Red during refactor, mock only at process boundaries). This
  skill assumes that cycle and adds the stage-specific conformance layer on
  top of it — coding standards, domain-implementation shape, and which L5
  item a given unit test is supposed to be verifying. Load
  `test-driven-development` for cycle sequencing; load this skill for what
  the resulting code and tests must structurally look like and trace to.
- **`test-breakage-thinking`** owns the *quality of ideation* in a test —
  which breakage scenarios earn a place in the test at all. This skill
  assumes the test case content was already decided (at the L5/L6 shift-left
  stage, per `vmodel-stage-detailed-design`) and governs whether the
  *implementation* that makes the test pass respects the stage's structural
  norms.
- **`code-minimalism`** owns the upstream judgement of *whether code should
  be written at all* (the seven-step ladder, dependency-adoption criteria).
  This skill is downstream of that decision: once the decision to write
  code is made, this skill governs its shape, invariant placement, and
  verification obligation. The hardcode-relocation decision point in this
  skill is the L7-implementation-time application of `code-minimalism`'s
  Section 3 hardcode-smell list.
- **`design-principles-pillars`** is this skill's direct upstream source —
  the seven pillars, the domain-implementation policy, and the class/method
  norms it states in general form. This skill restates and applies those
  same rules specifically as *stage conformance obligations with an exit
  checklist*, tied to trace-freeze, rather than as standalone design
  guidance usable at any layer. Load `design-principles-pillars` when the
  judgement call is about where an invariant or design decision belongs in
  the abstract; load this skill when the question is whether this stage's
  exit criteria are satisfied.
- **`refactoring`** owns the general Refactor-drive-model *process* (scope
  check, one-structural-change-per-commit cycle, `kind=refactor` PLAN
  checklist). This skill supplies the *measured trigger table* that
  justifies opening a refactor step in the first place during ordinary
  implementation work, distinct from a dedicated Refactor-drive PLAN. Once a
  trigger fires and a refactor step is opened, hand off to `refactoring`'s
  cycle discipline.

## Anti-patterns

- Building the full value-object/factory ceremony for PoC-scale spike code
  that has a pending delete/promote decision at S4.
- Accepting a first-run-green unit test as verification of an L5
  decision-table rule without investigating why it never went Red.
- Refactoring mid-implementation on an unmeasured "this looks messy"
  impression instead of citing one of the measured triggers.
- Treating a green CI gate as proof the implementation satisfies the L5
  spec, rather than checking that the executed tests actually verify the
  specific L5 items they claim to trace to.
- Letting AI-agent output write to a repository/DB layer directly because
  its JSON was schema-validated once, instead of routing it through the
  domain factory.
- Accepting code with a boolean flag argument or a nested `else` on the
  happy path because its tests currently pass — passing tests do not
  certify structural conformance to the class/method norms.
