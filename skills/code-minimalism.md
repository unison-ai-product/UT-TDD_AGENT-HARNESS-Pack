---
schema_version: skill.v1
name: code-minimalism
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Retrofit
decision_points:
  - when: "a new requirement, feature request, or 'nice to have' is about to be turned into a design/PLAN item before any code is written"
    choose: "ask whether the requirement can be dropped and, if so, record the reason in the PLAN's tailoring/scope note and skip implementation"
    over: "accept the requirement as given and start scoping the implementation"
    because: "code is a liability (maintenance, review, attack surface), not an asset — the feature is the asset — so a requirement that can be legitimately dropped is worth more than the code that would have implemented it"
  - when: "a candidate feature is a low-frequency, low-effort manual task (e.g. quarterly, 5 minutes) that someone proposes to automate"
    choose: "write a one-page runbook / operational procedure instead of code"
    over: "implement an automation script or scheduled job for it"
    because: "the automation break-even is frequency times per-run effort times lifetime; a rarely-run cheap manual task costs less than the ongoing maintenance of the automation that replaces it"
  - when: "about to implement sorting, retry, caching, validation, or pagination logic from scratch"
    choose: "spend up to ~10 minutes checking whether the framework, DB, or OS standard library already provides it, and use that"
    over: "write a custom implementation without checking for an existing standard mechanism"
    because: "reinventing a wheel that already exists is a research failure, not a knowledge gap — these primitives are almost always already available"
  - when: "a branch condition or literal value encodes a business-decided number, environment-specific value, or anything someone may want to change without a release"
    choose: "move it to `.ut-tdd/` config, an external settings file, or a master/reference table, with the source decision traced (PLAN ID or requirement ID), not just a comment"
    over: "hardcode the value directly in source and leave an explanatory comment"
    because: "the test for placement is whether the value/branch is something someone will want to change without shipping a release — hardcoding it means every future business change becomes a release event"
  - when: "an early hardcode, `@ts-ignore`, or design gap is found during implementation but cannot be fixed right now"
    choose: "file it as a tracked debt entry via [[debt-register]] (dedicated PLAN or `debt_items` field) with a concrete TTL"
    over: "leave a bare `// TODO: fix later` comment and move on silently"
    because: "recorded debt is a management decision with an owner and expiry; a silent, unrecorded shortcut is an accident waiting to be discovered later, invisible to `ut-tdd doctor`"
  - when: "the same behaviour appears to require a new abstraction layer, extension point, or configuration option that no current caller needs yet"
    choose: "write only the minimal signature the current caller requires (YAGNI), designing the interface from the caller's call site"
    over: "add the abstraction/config option now because it might be needed later"
    because: "the future need usually does not arrive on schedule, and when it does arrive the requirement is known and the implementation can be both cheaper and more accurate than a speculative one written today"
  - when: "adding a third-party library dependency instead of writing the ~dozens of lines it would take with the standard library"
    choose: "answer four questions first (last release within a year? multiple maintainers? code the team can actually read? is there an exit path via a swap-out design point?) and record the decision in a `docs/adr/` ADR"
    over: "add the dependency without an ADR because it saves time now"
    because: "a dependency is not 'no code' — it is inheriting someone else's liability (EOL, vulnerabilities, breaking changes, ramp-up cost); an unrecorded adoption decision leaves the team unable to reconstruct why the risk was accepted"
  - when: "an implementation proposal (by a human or an AI agent) is about to be written up as complete or ready for review"
    choose: "state in the proposal which step of the 7-step pre-writing ladder (drop / absorb-in-ops / already-exists / config-or-data / shared-component / buy-or-adopt / write-minimal) the work stopped at, and report satisfied requirement IDs, not lines of code produced"
    over: "report the proposal by describing how much code was written or generated"
    because: "code volume is not an achievement — a review answer of 'stopped at step 4: solved by config, no code needed' is a higher-value outcome than a large diff, and only requirement-ID coverage is what the review and traceability gates actually check"
---

# code minimalism

The discipline of exhausting the option to not write code before writing any.
Code is treated as a liability — the feature (observable behaviour) is the
asset, and every line written adds ongoing maintenance, review, test, and
attack-surface cost. This skill governs the judgement made **before and while
choosing to write code**: whether to write it at all, where a value or
decision belongs if not in source, and whether to adopt a dependency instead
of writing it yourself.

## When to load this skill

- Before writing any new code for a requirement, feature, or fix — at PLAN
  scoping time or at the start of L5/L6 design.
- Before proposing to add a library, framework, or SaaS dependency.
- When a literal value, threshold, or branch condition is about to be written
  directly into source.
- When technical debt is created or discovered during implementation.
- When estimating implementation size, or when a generative-AI agent is about
  to produce a large amount of code cheaply.

## 0. Starting attitude

**Code is not an asset; it is a liability. The asset is the feature
(behaviour).** Every line written increases the ongoing cost of maintenance,
testing, review, attack surface, and the ramp-up cost for the next reader.
The same feature delivered with less code has a better cost profile — the
strongest code is the code that was never written.

This is not a justification for laziness. **Choosing not to write code takes
more judgement than writing it.** Negotiating a requirement down, researching
what already exists, and designing a configuration surface are all harder
than writing a first-draft implementation. This matters especially for AI
agents: writing code is the path of least resistance when generation is
nearly free, and a generative AI left unconstrained will default to solving
everything with more code. Cheap-to-generate is not a reason to write it —
the maintenance, review, and attack-surface cost is not reduced by how the
code was produced.

## 1. The seven-step ladder — ask before writing

Before writing a line of implementation code, work through these questions
**in order**, and record where the ladder stopped (a one-line note in the
PLAN or proposal is the accountability mechanism: "considered 1-6, wrote at
7"):

1. **Can the requirement be dropped?** Is this requirement actually
   necessary? "Would be nice to have" is a euphemism for "not needed." A
   proposal to drop scope can be worth more than the implementation — record
   the reason in the PLAN's tailoring/scope note.
2. **Can operations absorb it?** The break-even for automation is
   frequency × per-run effort × lifetime. Automating a task that runs once a
   quarter and takes five minutes manually is a net loss once maintenance
   cost is counted. If a one-page runbook covers it, that wins.
3. **Does it already exist?** Has the team spent ~10 minutes checking
   framework, DB, or OS standard functionality? Sorting, retry, caching,
   validation, and pagination almost certainly already exist somewhere
   reachable. Reinventing them is a research failure, not a knowledge gap.
4. **Can it be config or data instead of code?** If a branch condition
   encodes a business rule, it belongs in a master table or an externalized
   settings surface, not in an `if`. Test: "will someone want to change this
   value/branch without shipping a release?" If yes, writing it into code is
   already a loss.
5. **Does a shared component already cover it?** Check for existing shared
   modules before writing a third near-duplicate implementation. Two similar
   implementations is the trigger to consider consolidation before a third is
   added.
6. **Can it be bought or adopted?** Compare against a mature OSS library or
   SaaS at least once. If building in-house is still chosen, record the
   reason in a `docs/adr/` ADR (see the dependency-adoption criteria below —
   adoption has its own risk this step must weigh against).
7. **Write it.** Only once steps 1-6 are exhausted, write code — and minimize
   what gets written (Section 2).

## 2. Minimizing what gets written once the decision is "write"

- **Apply YAGNI mechanically.** Do not write abstraction layers,
  configuration options, or extension points for a "future" need that no
  current caller requires. Writing them later, once the requirement is known,
  is both cheaper and more accurate — the future need usually does not arrive
  on the assumed schedule. The one exception is an explicitly designed
  swap-out/extension point that is itself a recorded design decision.
- **Design the interface from the caller's side.** Write the calling code
  first and implement only the minimal signature it requires. Designing from
  the implementation side tends to grow methods for "maybe useful" cases that
  no caller actually needs.
- **Deletion is a first-class commit, not an afterthought.** Unreachable
  code, disabled flags, commented-out corpses, and unused options should be
  removed as soon as they are found. History lives in git — "it might be
  needed later" is distrust of git, not a reason to keep dead code. A PR
  whose deleted-line count exceeds its added-line count is a good outcome,
  not a red flag.
- **Boring code over clever code.** Metaprogramming, excessive DRY, and
  tricky one-liners trade a smaller line count for a larger comprehension
  cost — that is a false economy. What should be minimized is **total cost of
  ownership**, not line count. Duplication that occurs fewer than three times
  is cheaper than a wrong abstraction; a bad shared abstraction is one of the
  most expensive debts to carry.

## 3. Hardcode smell list — stop and relocate

While writing a value or branch condition, stop and relocate it if it matches
any of the following (source: what should be config/data vs. code):

- **Varies by environment** → connection strings, paths, ports belong in
  environment configuration. "Just use localhost for now" always leaks to
  production eventually.
- **Is a secret** → credentials and keys never go in design docs, source, or
  commit history. Secret-scanning is the last net, not the primary control.
- **Is a business-decided number** → rates, caps, thresholds. Ask "who will
  want to change this, and when?" If the business side owns the number,
  hardcoding it turns every future business change into a release event.
  Route it to a master table or config surface, and trace its origin (which
  requirement/decision) rather than only leaving a comment.
- **Is a human-readable string** → display text belongs in a localization/
  copy layer. Literal strings in source code invite inconsistency and missed
  i18n coverage.
- **Smells customer-specific** → `if tenant_id == "acme"` is close to the
  worst hardcode: per-customer branches multiply without bound. Route to
  tenant configuration instead.
- **Assumes a fixed time or locale** → hardcoding "today," a fixed timezone,
  or a fiscal-year start date will break the first time the assumption is
  tested against a shifted clock or locale. Make it injectable.

If a hardcode is found but cannot be fixed immediately: **do not leave it
silent**. File it through [[debt-register]] as an intentional debt entry with
a TTL. Recorded debt is a management decision; silent debt is an accident.

## 4. Dependency addition — an import is code too

Adopting a library looks like "not writing code" but is actually **adopting
someone else's liability**: end-of-life risk, vulnerabilities, breaking
changes, and ramp-up cost. Decision criteria:

- Do not add a dependency for something the standard library plus a few dozen
  lines already covers (the `left-pad` lesson).
- Before adopting, answer four questions, then record the answers in a
  `docs/adr/` ADR:
  1. Was there a release within the last year?
  2. Are there multiple maintainers (not a single-person project)?
  3. Can the team actually read the dependency's code if something breaks?
  4. Is there a described exit path (a swap-out design point per step 4 of
     the ladder above) if the dependency needs to be replaced?
- The most dangerous dependency is the one added "just to try it out." Keep
  trial usage on a branch; write the ADR at the point it merges to the main
  line.

## 5. Operating rules for the generative-AI era (this harness)

- At the start of an implementation proposal, an agent states in one line
  which step of the 7-step ladder (Section 1) it stopped at. "Stopped at
  step 4: resolved by config, no code needed" is a top-tier answer, not a
  non-answer.
- Do not report code volume as an achievement. Report satisfied requirement
  IDs (PLAN/assign trace), not line counts.
- This principle is a valid attack angle in [[adversarial-review]]: "this
  implementation should have stopped at ladder step 3 (already exists)" is a
  legitimate finding. A design/code review should look not only for what is
  missing but for **what did not need to be written**.
- Guard against the volume temptation: do not fold "while I'm in here" extra
  implementation into a task beyond the single PLAN/assign-table line being
  worked. Unscoped extra code has no requirement trace (orphaned), no test
  obligation captured (gap), and skips review — exactly what the gates exist
  to catch, so avoid generating it in the first place.

## Boundary with existing skills

`code-minimalism` governs the judgement made **before code exists** — whether
to write it, how much to write, and where a value belongs. It is the
upstream gate; the following skills govern what happens **after code already
exists**:

- [[refactoring]] — behaviour-invariant restructuring of code that already
  exists. It assumes the decision to have code was already correct and asks
  "how do we keep this safe while changing its shape?" `code-minimalism` asks
  the earlier question: "should this code exist at all, or this much of it?"
- [[debt-register]] — the tracking mechanism once a shortcut has already been
  taken (Section 3 and Section 1 step-1 notes route into it). `code-minimalism`
  decides when something is debt-worth-recording versus scope that should
  never have been written; `debt-register` owns the lifecycle (TTL, discharge)
  once that call is made.
- [[incremental-implementation]] — quality baseline for code once the
  decision to write it has already been made (typing, naming, function size,
  commit discipline). `code-minimalism` is upstream of that scope: it decides
  whether a module, abstraction, or dependency should be written at all
  before `incremental-implementation`'s per-commit rules apply.
- [[spec-driven-development]] — defines the spec that a test is written
  against once a feature is confirmed in scope. `code-minimalism` is
  consulted earlier, often during the same PLAN-scoping conversation that
  produces the spec, to negotiate the requirement itself down (ladder step 1)
  before a spec is written for it.

## Anti-patterns

- Treating "AI can generate this cheaply" as a reason to write it — generation
  cost is not maintenance, review, or attack-surface cost.
- Reporting implementation completeness by describing how much code was
  produced rather than which requirement IDs are now satisfied.
- Adding a dependency without answering the four adoption questions and
  recording an ADR, because "it's just an import."
- Leaving a hardcoded business number with only a comment instead of tracing
  it to config/data and its originating decision.
- Silently carrying a known shortcut instead of filing it through
  [[debt-register]] with a TTL.
- Writing a speculative abstraction or config knob for a need no current
  caller has, "to save time later."

## External corroboration

- Martin Fowler, "Yagni" — https://martinfowler.com/bliki/Yagni.html (four hidden costs of building early: build/delay/carry/repair; YAGNI does not apply to refactoring effort)
- Martin Fowler, "Tolerant Reader" — https://martinfowler.com/bliki/TolerantReader.html (loose coupling to dependency schemas)

