---
schema_version: skill.v1
name: test-breakage-thinking
skill_type: testing
applies_to:
  layers:
    - L6
    - L7
    - L8
    - L9
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Discovery
decision_points:
  - when: "a full test suite passes on the very first run after writing it"
    choose: "insert a deliberate bug and confirm at least one test turns Red (a manual mutation check) before treating the suite as trustworthy"
    over: "reporting done on the strength of the first green run"
    because: "an all-green first run is far more often a sign of a weak suite than of a correct implementation — an unexplained pass on a test that has never seen a failing case carries almost no information."
  - when: "the expected value for a test (a report total, a search ordering, a generated output) is not self-evident from the spec"
    choose: "fix the oracle's independent origin first — the spec's formula, an independent hand calculation, a second implementation, or confirmed historical data"
    over: "deriving the expected value by running the implementation and reading off its output"
    because: "an expectation derived from the implementation under test is a tautology that fixes the implementation's bugs in place instead of catching them; if no independent origin exists, that is itself a defect in the requirement, not a testing inconvenience."
  - when: "a test fails intermittently (flaky) under repeated runs"
    choose: "diagnose the failure as a concurrency, timing/wait, or data-isolation defect and fix or quarantine it with a filed issue"
    over: "re-running the test until it goes green and moving on"
    because: "flakiness is itself evidence of a concurrency or isolation bug; retry-to-green launders that signal away instead of resolving it."
  - when: "deciding how much depth to allocate across a set of test targets under a limited budget"
    choose: "prioritize irreversible operations (billing, deletion, external sends), boundary crossings (tenant, permission, external interface), historically failure-prone modules, and new complex logic over stable, framework-guaranteed CRUD"
    over: "diagnosing every target to the same uniform depth"
    because: "uniform-depth diagnosis produces a pile of shallow confirmation tests; bugs cluster around irreversible operations, boundaries, and prior-failure history, so spending equal time on mature CRUD starves the targets where a miss is expensive."
  - when: "running an exploratory testing session outside the scripted test suite"
    choose: "write a one-line charter with an explicit timebox before starting (e.g. \"probe billing-boundary date manipulation for miscalculation — 30 min\")"
    over: "starting to click around without a stated target or time limit"
    because: "exploration with no charter and no timebox degrades into an unfocused walkthrough that produces no reviewable record of what was and was not covered."
  - when: "recording a bug found during exploratory testing or diagnosis"
    choose: "write the reproduction as the triggering CONDITION (e.g. \"saving after session expiry while an unsaved edit exists\") and then vary that condition to search for sibling bugs in the same area"
    over: "recording only the literal click-by-click steps and moving to the next item once the one instance is filed"
    because: "a condition-level description proves the cause has actually been located, and one bug found is a signal that its neighborhood (same author, same pattern, same era of code) is worth a second look — finding the family is far more valuable than the single report."
  - when: "marking a checklist row (diagnosis, review, or acceptance checklist) as done"
    choose: "ask \"can I construct a counterexample that defeats this row right now\" and record the done evidence as an actual observation (e.g. \"403 measured under role X\")"
    over: "marking the row done because the corresponding code exists or reads correctly"
    because: "a checklist is a prompt for thinking, not a substitute for it; \"the code looks right\" is not evidence — code read and code executed are different things, and a row that a counterexample can still defeat is not actually done."
  - when: "deciding whether to keep testing or stop and report readiness"
    choose: "stop only once new test/exploration effort has stopped surfacing new information and write out the residual risk in one sentence (what is untested, its impact if broken, and how it would be detected in production)"
    over: "stopping once the checklist is fully checked off or a coverage percentage target is hit"
    because: "testing has no logical end point (zero defects is unprovable), so the stop decision is an economic/risk judgment that must be made explicitly; if the residual-risk sentence cannot be written, the stop decision has not actually been made carefully."
---

# test breakage thinking

Test-case ideation quality: how to find the ways a feature actually breaks,
how much depth a given target deserves, and when accumulated testing is
enough to stop. This skill governs the *content* that goes into test cases,
exploratory sessions, and diagnostic checklists — not the suite architecture,
the Red-first cycle order, or the evidence-recording discipline around those
artifacts.

## When to load this skill

- Designing test cases for an L6/L8/L9 test-design doc and deciding which
  scenarios actually belong in it.
- Writing GWT integration blocks for `docs/test-design/L8/` and choosing what
  the "When" should try to break.
- Running an exploratory testing session outside the scripted suite.
- Judging whether a diagnosis or QA checklist row is genuinely satisfied, or
  is just formally filled in.
- All tests pass on the first run and something about that feels too easy.
- Deciding how much test depth a PLAN's scope actually warrants under a
  limited budget.
- Deciding whether test coverage for a PLAN is sufficient to close it out.

## Boundary with existing skills

This skill is about the *quality of ideation*, not the surrounding process.
Load it alongside, not instead of, the following:

- **[testing](testing.md)** owns test-suite architecture: which level a test
  belongs at (unit/integration/system/acceptance), fixture placement,
  `harness.db` isolation, and the Vitest runner mechanics. It tells you
  *where a test lives and how it is executed*. This skill tells you *what
  the test should actually try to break* once you know where it belongs.
- **[test-driven-development](test-driven-development.md)** owns the
  Red-first cycle order — write the failing test, watch it fail, then write
  the minimum source to pass. It governs *sequence*. This skill governs the
  *content* of the test written in the Red step: a technically-Red test that
  only exercises a happy path still fails this skill's bar even though it
  satisfies TDD's cycle order.
- **[verification](verification.md)** owns evidence discipline for
  descent/trace correctness — confirming design artifacts actually pair with
  test artifacts and that machine gates reflect substance. It answers
  "does the paperwork trail hold up." This skill answers "did the tester
  actually go looking for the failure modes that matter," which verification
  cannot detect by reading trace links alone.

In short: testing = suite shape, TDD = suite sequence, verification = trace
evidence, this skill = the thinking that decides which breakage scenarios
earn a place in any of them.

## 0. Starting attitude

**The purpose of a test is to discover how something breaks, not to confirm
that it works.** A test written in a "confirm it works" mindset only catches
the failure modes its author already imagined — and those are usually
already fixed by the time the code is written, so confirmation tests tend to
pass immediately. A test that passes immediately carries little information.

Behaviors that follow from this attitude:

- Before writing a test, verbalize at least three distinct ways the feature
  under test could break. If you cannot verbalize three, you do not yet
  understand the feature well enough to test it.
- **If an entire test suite goes green on its first run, be suspicious rather
  than pleased.** That outcome is far more often "the tests are weak" than
  "the implementation is perfect." Insert a deliberate bug and confirm the
  suite catches it (a manual mutation check). A test that cannot be made Red
  by a real bug is a candidate for deletion.
- Do not report "the tests passed" as "this is correct." The accurate claim
  is "no breakage was observed against the declared test set" — the same
  logic as the first layer of a layered-defense model: passing evidence is
  scoped to what was actually checked, not a universal correctness claim.

## 1. A catalog of viewpoints for finding breakage

Use these as questions to run mentally when looking at a target, not as a
checklist to execute mechanically.

### 1-1. Input viewpoint — "zero, one, many, boundary, foreign"

- **Zero**: empty string / empty array / null / zero rows / zero amount /
  unset. Confirm "absent" is handled specially, or should be.
- **One**: with exactly one item, are pluralization, aggregation, and paging
  correct?
- **Many**: exactly at the limit / limit+1 / ten times real-world volume.
  Paging boundaries (with a 20-item page, item 20 vs. item 21).
- **Boundary**: wherever the spec has a number, test that exact value and its
  ±1. If the spec has no number where one is implied, that absence is itself
  a finding (undecidable = a defect to raise, not a gap to test around).
- **Foreign input**: emoji, surrogate pairs, RTL characters, control
  characters, full-width digits, leading/trailing whitespace, embedded
  newlines, SQL metacharacters. For non-Latin scripts, encoding-dependent
  characters and legacy glyph variants.

### 1-2. Time and ordering viewpoint — bugs live "in between"

- **Reorder the operations**: instead of save -> edit -> delete, try
  delete -> edit.
- **Abandon midway**: close the browser on step 3 of a wizard. Drop the
  connection mid-upload.
- **Do it twice**: double-submit the same request (idempotency). Double
  click. Does a retry cause a double charge?
- **Do it concurrently**: two sessions editing the same resource. Two buyers
  racing for one unit of stock.
- **Let time pass**: an action after session expiry. Month-end, leap year,
  DST transitions, timezone boundaries. Is "next month" from Jan 31 handled
  correctly?

### 1-3. State viewpoint — attack the blank cells of the transition table

If a state-transition diagram exists, do not just exercise the drawn
transitions — attack the **undrawn state x event combinations** (the blank
cells). A blank cell means "should not happen," and "should not happen" is
often simply unimplemented. What happens if an edit event is sent to an
already-approved request?

### 1-4. Permission and boundary viewpoint — always try "not mine"

- Directly reference another user's resource ID (IDOR). Another tenant's ID.
  A deleted ID.
- Downgrade the role by one level and repeat the same operation. Hit the API
  directly, bypassing the UI.
- Keep this viewpoint active inside ordinary functional tests, not only in a
  dedicated security pass — permission and tenant-boundary checks belong in
  L8 GWT scenarios wherever a resource ID crosses a trust boundary.

### 1-5. Failure-mode viewpoint — dependencies always eventually fail

For every external API, DB, queue, or storage dependency, assume each of:
slow, down, returns a malformed value, and **partially succeeds** (e.g. 2 of
3 records sent before failure). Partial success is where compensation-logic
holes show up most often. The error message itself is also test surface:
does it leak internal detail (stack trace, SQL), and can the user act on it?

### 1-6. Oracle-problem viewpoint — who actually knows "correct"

For tests where the expected value is not self-evident (a report
calculation, a search ordering, an AI-generated output), fix the
**independent origin of the expected value** before writing the assertion.
A test whose expected value is derived by running the implementation and
reading off its output is a tautology that locks in that implementation's
bugs. Valid origins: the spec's formula, an independent hand calculation, a
second implementation, or confirmed historical data. If no independent
origin exists, that is an untestable requirement — a defect in the
requirement to raise, not something to work around in the test.

## 2. Allocating depth — a risk-based approach

Diagnosing every target to the same depth just produces a pile of shallow
confirmation tests. Allocate depth using this priority order:

**Dig deep on, in this order:**

1. **Irreversible operations** — billing, deletion, external sends, legal
   records. Anything where a bug cannot simply be fixed after the fact.
2. **Boundaries** — tenant boundaries, permission boundaries, external
   integration surfaces. The blast radius of a boundary breach is orders of
   magnitude larger than an ordinary functional bug.
3. **Historically dirty areas** — modules with a high change-failure rate or
   a track record of failed/blocked work. Bugs cluster; digging further
   around a spot where one was already found is statistically the right
   move.
4. **New, complex logic** — heavy branching (decision-table territory),
   concurrency, state machines.

**Stay shallow on:** mature, stable CRUD; anything the framework already
guarantees; display-only surfaces that are cheap to restore if wrong. Digging
deep here is wasted effort that starves the targets above of the time it
takes from them.

## 3. Rules for exploratory testing

Discipline for walking outside the scripted suite — not "poking around
aimlessly."

1. **Write a one-line charter with a timebox before starting**: e.g. "probe
   the billing boundary for date-manipulation miscalculation — 30 minutes."
   Exploration with no stated target and no time limit is a stroll, not
   testing.
2. **Log anomalies as they happen; judge them later**: "the layout glitched
   for a moment," "an error appeared once but not on retry" — record it even
   if it will not reproduce on demand. A meaningful fraction of
   non-reproducing anomalies later turn out to have been the first sighting
   of a real bug.
3. **When you find one bug, vary it to find its family**: look for siblings —
   the same author's code from the same period, other screens sharing the
   same pattern. Identifying a bug's family is worth roughly an order of
   magnitude more than reporting the single instance.
4. **Record findings as reproduction conditions, not click sequences**: not
   "click X, then click Y" but "with an unsaved edit pending, saving after
   session expiry triggers...". If the finding cannot be phrased as a
   condition, the root cause has not actually been located yet.

## 4. Operating diagnosis and QA checklists without letting them go hollow

A checklist (a diagnosis sheet, a QA readiness checklist, an acceptance
checklist) is a prompt for thinking, not a substitute for it. Concretely:

- Before marking any row done, ask yourself: **"can I construct a
  counterexample that defeats this row right now?"** If you can construct
  one, the row is not done.
- Record the "done" evidence as an **observation**, not an inference:
  "measured a 403 under role X" is evidence; "should be implemented that
  way" or "the code looks right on read" is not — code that has been read
  and code that has been executed are different things.
- If you notice something the checklist does not cover, **add a row before
  diagnosing it**. Growing the list correctly is the diagnoser's job; a
  checklist that never grows has stopped tracking reality.
- If every row comes back "done" for several cycles in a row with no
  findings, treat that streak itself as a signal the checklist has drifted
  out of sync with the real system, not as evidence of quality.

## 5. Deciding when to stop

Testing has no logical end point — the absence of defects is unprovable — so
the stop decision is an economic and risk judgment, made explicitly rather
than implicitly:

- **Signals that it is reasonable to stop**: new tests/exploration have
  stopped producing new information (no new findings across the last N
  cases); recent findings are all variations of already-known families; the
  remaining unexplored area is limited to the "stay shallow" targets from
  section 2.
- **Signals it is not yet reasonable to stop**: the discovery rate has not
  yet dropped; a significant finding just occurred (bugs cluster, so the
  area around a recent find is still worth probing); irreversible-operation
  territory still has unexplored area.
- The stop decision must be paired with **verbalized residual risk**: "X
  remains undiagnosed; if it breaks, the impact is Y; detection would come
  from Z (a monitoring signal, an alert, a support report)." If that sentence
  cannot be written, the stop decision was made too casually. When it can be
  written, record it as part of the PLAN's `review_evidence` or the release
  Go/No-Go record.

## Mapping to UT-TDD

- L8 GWT integration test design (paired with [spec-driven-development](spec-driven-development.md))
  is where the boundary, ordering, and partial-failure viewpoints from
  section 1 should show up as explicit scenarios, not only the happy-path
  Given/When/Then.
- `ut-tdd doctor` and gate runs confirm structural presence of tests; they
  cannot confirm the tests actually target real breakage. Use this skill's
  section 4 self-challenge ("can I construct a counterexample") before
  treating a green gate as sufficient — the same distinction the
  [verification](verification.md) skill draws between coverage and substance.
- Residual-risk sentences from section 5 belong in the PLAN's
  `review_evidence` at review/accept gates, and in a release Go/No-Go record
  where the harness maintains one.

## Anti-patterns

| Anti-pattern | Why it fails | Do instead |
|---|---|---|
| Satisfied by happy-path coverage | Expected failure modes are already fixed by implementation time | Design from the breakage viewpoints in section 1 |
| Deriving expected values from the implementation | Tautological — locks the implementation's bugs in place | Fix the oracle's independent origin first (section 1-6) |
| Treating coverage % as the goal | A line executed is not the same as a line verified; an assertion-free run still raises coverage | Use coverage only to find *unexamined* areas, never as a target |
| Retrying a failing test until it goes green | Flakiness is itself evidence of a concurrency/isolation bug | Diagnose and fix flaky tests one at a time; quarantine and file if truly blocked |
| Treating "filled-in checklist" as the goal | Formal completion with zero findings, repeated, is a drift signal, not quality | Apply the section 4 counterexample self-challenge; grow the list |
| Reporting findings with no severity | Recipients cannot prioritize and end up ignoring everything | Sort findings by severity before reporting |

## External corroboration

- Kent Beck, "Test Desiderata" — https://testdesiderata.com/ (twelve test properties are trade-off axes, not a checklist)
- Google Testing Blog, "Just Say No to More End-to-End Tests" — https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html (pyramid discipline; more tests is not better)
- Codecov, mutation testing in practice — https://about.codecov.io/blog/mutation-testing-how-to-ensure-code-coverage-isnt-a-vanity-metric/ (run incrementally on critical modules, not 100% everywhere)

