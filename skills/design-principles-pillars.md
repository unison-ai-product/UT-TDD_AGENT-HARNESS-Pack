---
schema_version: skill.v1
name: design-principles-pillars
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Refactor
decision_points:
  - when: "A new domain invariant (e.g. an amount must be non-negative) is being implemented."
    choose: "encode it as a guard clause inside the value object's private constructor, invoked only through a create() factory"
    over: "validating it only in the API handler or controller layer"
    because: "the capture-first pillar requires catching invalid state at the fastest static/type layer, and the complete-constructor policy places the single source of invariant enforcement inside the value object; validating only at the boundary leaves a second code path (direct construction) able to produce an invalid object."
  - when: "A business rule is cross-cutting, time-dependent, or a state-machine transition rule (e.g. seat count within a plan limit, allowed status transitions)."
    choose: "implement it as an aggregate-root method invariant plus a property-based or scenario test, and add a runtime assertion"
    over: "trying to express it purely as a type or schema constraint"
    because: "the self-audit matrix and the limits chapter both show types/schema catch structural, single-field rules well, but cross-cutting, temporal, and state-machine rules are not caught by types alone and must live in domain logic plus property tests plus runtime assertions."
  - when: "Code needs to persist data derived from an AI/LLM output."
    choose: "route it through JSON output -> schema validation -> domain factory -> repository, and treat the AI output as outside the trust boundary the whole way"
    over: "letting the generating agent or its output call the repository or DB layer directly"
    because: "the AI-boundary pillar requires AI output to act only through validated intermediate JSON; a direct DB write from AI output bypasses the one place domain invariants are enforced."
  - when: "Constructing a domain object from untrusted input (API/CLI/UI submission) versus from a persisted DB row or event."
    choose: "use create() with full invariant validation for untrusted input, and reconstruct() with minimal trusted validation for persisted state, keeping the raw constructor private in both cases"
    over: "using a single public constructor for both paths"
    because: "the generation-vs-reconstruction split exists precisely so invariant validation is not duplicated in more than one place; re-running full validation on already-trusted persisted state duplicates the single source of truth the value-object policy requires."
  - when: "A method signature needs more than about three parameters, or a boolean flag to select between two behaviours."
    choose: "collapse the parameters into a value object / parameter object, or split the method into two named methods"
    over: "adding a boolean flag argument and branching inside the method body"
    because: "the method-design norms ban flag arguments outright and cap argument count near three; a flag argument hides two responsibilities behind one signature, which also breaks the single-responsibility rule for methods."
  - when: "An expected, recoverable input error occurs (e.g. a title exceeds the allowed length) versus a genuine domain invariant violation."
    choose: "return Result<T, Violations> for the expected input error, aggregating all violations before returning, and reserve thrown exceptions for invariant violations or unrecoverable states"
    over: "throwing an exception for both cases, or throwing on the first violation found"
    because: "both the value-object policy and the class/method norms restrict exceptions to invariant violations; expected input errors must be collected at the boundary so a caller sees every violation, not just the first one raised."
  - when: "A new requirement could plausibly be satisfied by deleting scope, an operational workaround, an existing framework/DB/OS feature, configuration, or an existing shared component, instead of new code."
    choose: "walk the minimum-code priority order (drop the requirement -> solve by ops/process -> use an existing/standard feature -> move it to config/data -> reuse an existing component -> buy -> write code) and only write new code after the earlier steps are ruled out"
    over: "writing new code first because it is the most direct path to the requirement"
    because: "the minimum-code pillar treats code as debt from the moment it is written; skipping the priority order produces code that could have been avoided, and cheap-to-generate code in the AI era is not cheap to maintain, review, or secure."
  - when: "A connection URL, credential, business threshold, display string, tenant-specific value, or numeric literal is about to be written directly into source."
    choose: "move it to the location the hardcode-ban table assigns to that category (environment/config for connection info, secrets management for credentials, config or master data for thresholds, a translation catalog for display text, tenant settings for tenant-specific values, a named constant for any other literal)"
    over: "leaving the literal embedded in the code because it is small or 'obviously' fixed"
    because: "the hardcode-ban rules tie each embedding ban to a specific correct location and a stated reason (e.g. environment differences must be absorbed without code changes, tenant isolation must not leak); treating this as a generic 'avoid magic numbers' rule loses the placement guidance the table encodes."
---

# design principles pillars

The seven design pillars (from the product's top-level design-principles
document), plus the domain-implementation policy (complete-constructor /
value-object) and the class/method design norms that make the pillars
mechanically checkable. This skill exists so a cheap model can apply the
pillars as concrete construction/review rules instead of restating them as
prose aspirations.

## When to load this skill

- Writing or reviewing a value object, entity, or aggregate root and deciding
  where an invariant should live.
- Writing or reviewing a method/class shape (argument count, control flow,
  error handling) and needing a mechanical pass/fail rule.
- Deciding whether a new requirement needs new code at all.
- Reviewing whether AI-generated code respects the AI trust boundary.
- Any L3-L7 design or implementation decision where "use good judgement"
  would otherwise be the only guidance available.

## The seven pillars

The pillars are not parallel; they nest. Pillar 1 (capture-first) is the meta
principle. Pillar 4 is the overall verification strategy; pillar 2 is the
micro TDD loop inside it; pillar 1 is the fastest static/contract gate inside
that. Pillar 6 applies pillars 1 and 4 specifically to AI agents. Pillar 7
extends capture from build-time into runtime and into requirement-to-test
closure. The shared thread across all seven: make invalid states
unrepresentable, keep a single source of truth that generates/cross-checks
everything else, put a verification gate at every boundary, and prefer forms
a machine can judge.

| # | Pillar | Claim | Judgement it forces | Failure smell |
|---|--------|-------|----------------------|----------------|
| 1 | Capture-first (fail-fast, machine-verifiable) | Invalid state should be rejected as early and as statically as possible. | Push a rule down to the earliest layer that can enforce it mechanically: type, then schema, then DB constraint, before falling back to a test. | A rule that is "documented" but only enforced by a test that could be skipped, or not enforced at all until runtime. |
| 2 | Designed for TDD | Testability is a property of the design, not bolted on after. | Prefer pure functions, dependency injection, and small units so a Red-first test can be written before the code. | A function that cannot be tested without standing up a database or external service because I/O was not pushed to a boundary. |
| 3 | Extensibility / maintainability | The structure must stay resilient to change. | Keep DDD boundaries, favor composition and low coupling, and identify explicit replacement points before extending a module. | A change that requires touching many unrelated files because a boundary was crossed informally. |
| 4 | Verification strategy | Verification is organized by level, not ad hoc. | Choose the right technique per level: pyramid placement, property tests, contract tests (CDC), acceptance tests, plus AI-artifact verification for AI-produced work. | Treating "we have some tests" as equivalent to "we tested the right thing at the right level." |
| 5 | Non-functional guarantees | Quality characteristics (ISO 25010) must be explicitly satisfied, not assumed. | Especially security and performance: treat them as design inputs, not afterthought review comments. | A performance or security property that is only checked informally in review, with no NFR grid entry. |
| 6 | AI acts only through validated intermediate JSON | AI output is outside the trust boundary. | Route AI output through JSON -> schema validation -> domain factory -> repository. Never let AI output write to a database directly. | An agent or generated code path that calls a repository/DB layer directly with unvalidated AI output. |
| 7 | Observability / traceability | Capture extends into runtime and into requirement-to-test closure. | Attach structured log/trace identifiers (tenant, request, rule ID) at runtime; use Design-by-Contract assertions for invariants; use the trace ledger to machine-detect closure gaps between requirement -> design -> implementation -> test. | A production violation that cannot be traced back to the design rule it broke, or a requirement with no test that can be found by inspection alone. |

## Where capture actually works (and where it does not)

Structural, single-field rules (required field, string format, non-negative
number) are caught well by types, schema, and DB constraints. Cross-cutting,
temporal, state-machine, and business-logic rules (a plan's seat limit, a
state-transition reachability rule, a race condition) are **not** caught by
types alone — they must live in domain logic plus property/scenario tests
plus runtime assertions. Over-constraining low-value fields creates friction
without safety benefit; concentrate capture investment on the invariants that
actually matter. Schema is not the whole answer: wire format, application
model, and DB schema each have a role, and all three should be derived from
or cross-checked against one canonical source, not maintained as three
independent truths.

## Minimum-code principle (an eighth, applied pillar)

The code not written is the strongest code: every line written is a future
liability (maintenance, test surface, attack surface, onboarding cost).
Before writing new code, walk this priority order and be able to say why each
earlier step does not apply:

1. **Delete / reject** — is the requirement actually needed? An unused
   feature is negative code.
2. **Operations / process** — would a monthly manual step be cheaper than
   automating it? (Automation only pays off when frequency x effort x
   lifetime clears the cost of building it.)
3. **Existing / standard feature** — does the framework, DB, or OS already
   provide this? Check before reinventing it.
4. **Configuration / data** — can the branch or value live in config or
   master data instead of code?
5. **Reuse an existing component** — does an equivalent already exist in the
   shared component set, or as a near-duplicate implementation?
6. **Buy** — could a mature OSS library or SaaS replace this? Record the
   choice in an ADR.
7. **Write code** — only after the above six are considered and recorded,
   write the minimal implementation.

### Hardcode ban

Do not embed these directly in code; each has a designated home and a
specific reason:

| Never embed | Correct location | Why |
|---|---|---|
| Connection URL / port / path | Environment definition / config file | Environment differences must be absorbed without a code change. |
| Credentials / keys | Secrets management | Leaking a credential is irreversible. |
| Business thresholds / rates / limits | Config or master data, with source and change procedure documented | Business changes should not force a release. |
| Display strings / messages | Display-name / translation catalog (i18n) | A single source keeps wording and i18n consistent. |
| Tenant/customer-specific values | Tenant settings | Multi-tenant isolation principle. |
| Magic numbers | Named constants, with unit/meaning documented | Readability and preventing missed updates. |
| Dates / environment-dependent assumptions | Configuration / injection (for testability) | Code must tolerate "time passes" without being rewritten. |

### Debt-prevention rules

- **YAGNI** — do not write an abstraction or option for "might need later";
  writing it the day it's actually needed is cheaper (that day often never
  comes).
- **Boy Scout rule** — leave touched code slightly better than you found it,
  but never mix that cleanup with a behaviour change in the same commit.
- **Delete without hesitation** — unreachable code, disabled flags, and
  commented-out corpses are deleted on sight; git keeps the history.
- **Debt is allowed only if declared** — an intentional debt entry with a
  repayment deadline in the debt ledger is a management decision; an
  undeclared debt is an incident.
- **Every dependency added is debt added** — adopting one library means
  accepting its EOL, vulnerability surface, and learning cost; do not add a
  dependency to avoid writing a few dozen lines with the standard library.
- **Generative-AI-era note** — as the cost of writing code falls, this
  principle's value rises. Cheap to write is not a reason to write it —
  maintenance, review, and attack-surface cost have not gotten cheaper.

## Domain implementation essentials (value objects / aggregates)

- **Complete constructor**: an object is built already satisfying every
  invariant; there is no half-valid intermediate state.
- **Value objects are immutable, value-equal, and self-validating** — no
  setters. Business rules live on the value-object type, not scattered
  through procedural validation.
- **Aggregate roots own consistency** — state changes go only through
  aggregate-internal methods (e.g. a `Task` aggregate's `changeStatus()`),
  never by mutating a nested entity directly.
- **Invariants are concentrated in one place** (the VO or the aggregate) and
  are not re-validated redundantly at every boundary that touches them.
- **Generation vs. reconstruction are separate factories**:
  - `create(...)` — for new/untrusted input; validates every invariant.
  - `reconstruct(...)` — for restoring from persistence/events; treated as
    already trusted, minimal re-validation.
  - Only the factories are public; the raw constructor is private. An ORM or
    serializer that needs mutability gets a mapping layer that converts
    between VO and primitives — the mapping layer is not a second place
    invariants are enforced.
- **Boundary design**: everything outside the domain (API/UI/CLI) is
  received as an unvalidated input DTO, converted at the boundary via
  `create()` into a valid VO/aggregate, and represented outward via a
  separate response DTO. Errors are aggregated as `Result<T, Violations>`
  (or equivalent) — never throw on the first violation found. Exceptions are
  reserved for domain-invariant violations, not for expected/handleable
  input errors.
- **AI code-generation contract** (mechanical mapping a generator or reviewer
  can apply): value object -> immutable class/record with private fields, no
  setters, value equality; invariant -> constructor guard clause, violation
  raises a domain exception or returns a `Result`; enum-like VO -> enum/sealed
  type restricted to the declared set; entity -> identity (ID) plus
  state-transition methods; aggregate root -> one repository unit, one
  transaction boundary, external references by ID only; generation/
  reconstruction -> `create()`/`reconstruct()` factories, raw constructor
  non-public.

## Class and method design norms

**Control flow**: avoid `else` for the normal path — return early on the
unmet-precondition branch, keep the happy path unnested (`if (!ok) return;`
then the body, not `if (!ok) {...} else {...}`). Put guard clauses (input/
precondition checks) at the top of the function. Cap nesting depth at 2-3
levels — extract a function instead of nesting deeper. Prefer positive
conditions over double negatives (`if (isReady)` not `if (!isNotReady)`).
Fail fast: an invalid state fails immediately, not silently later.

**Methods**: single responsibility, one abstraction level per method — split
anything named "do X and then Y". Target roughly 20-30 lines; extract beyond
that. Cap parameters at roughly 3; beyond that, collapse into a value/
parameter object. No boolean flag arguments — split the method or use an
enum/strategy instead. Command-query separation: a method that changes state
does not also return a query result. Prefer purity (input -> output, no side
effect); push I/O to the boundary.

**Classes**: single responsibility — one reason to change; split when
responsibilities accumulate. Immutable by default, no setters (mirrors the
value-object policy) — a change produces a new instance. Composition over
inheritance — avoid deep inheritance hierarchies. Minimal public surface —
raw constructors are non-public, access goes through the factory. Dependency
direction: the domain does not depend on DB/UI; use dependency inversion.

**Null / error / exception handling**: never pass or return `null` — use
`Optional`, a value object, or an empty collection instead. An absent value
is explicit `Optional`, forcing the caller to branch. Expected/handleable
input errors return `Result<T, Violations>`, not an exception. Exceptions are
reserved for invariant violations or unrecoverable conditions, raised from a
guard clause. Errors are aggregated at the boundary — collect every
violation, do not throw on the first one.

**Complexity / readability**: keep cyclomatic complexity at roughly 10 or
below — split beyond that. No magic numbers — named constants, VOs, or enums
only. Prefer declarative processing (`map`/`filter`/`reduce`) over manual
loops when it expresses intent more clearly. Names express intent; avoid
abbreviations. DRY — duplication is routed to the shared component set, not
copy-pasted.

**Mechanical AI-generation / review checklist** (each item is a yes/no a
cheap model can apply without judgement calls):

- [ ] No `else` producing nested happy-path logic.
- [ ] No branch/loop nesting beyond 3 levels.
- [ ] No method with more than ~3 arguments or any boolean flag argument.
- [ ] No `null` returned or accepted (`Optional`/`Result` instead).
- [ ] No exception used for an expected/handleable input error.
- [ ] No setter or mutable field on a value object or entity.
- [ ] No side effect inside a query method (CQS held).
- [ ] No magic number left as a bare literal.

## Boundary with existing skills

- **`design-doc`** governs *how a design document is produced* (diagrams,
  layer obligations, freeze checklist for Mermaid/D2). This skill governs
  *what the design content must say* about invariants, value objects, and
  method/class shape once that document exists. Use `design-doc` for the
  artifact mechanics; use this skill for the substantive judgement calls
  inside an L3-L5 doc's domain model or class design sections.
- **`code-review-and-quality`** governs the W-gate review procedure (machine
  checks, test-substance audit, layer-obligation check, retrograde check for
  Refactor/Retrofit). This skill supplies the *specific rules* a reviewer
  applies when the review touches domain modeling or class/method shape
  (e.g. "is this invariant in the right place", "is this a flag argument").
  Load both together when a code review touches domain or class design; use
  `code-review-and-quality` for the review procedure itself.
- **`refactoring`** governs *safe structural change* (regression fence, one
  change per commit, behaviour invariance). This skill is what a refactor
  step is refactoring *toward* — e.g. moving an invariant from a controller
  into a value object is a structural change that should follow the
  `refactoring` skill's cycle, using this skill's rules to decide the target
  shape.

## Anti-patterns

- Re-validating the same invariant at the API boundary and again inside the
  value object "just in case" — invariants belong in exactly one place.
- Treating a passing type-checker/schema validator as proof that a
  cross-cutting or state-machine rule is safe — it only proves the
  structural, single-field rules are safe (see the capture matrix).
- Letting an AI agent's output reach a repository or DB call directly because
  "the schema already validated it once" — the validated-JSON -> domain ->
  repository path is the whole point of the AI boundary pillar, not an
  optional extra step.
- Writing new code to satisfy a requirement without first checking whether
  deletion, process, an existing feature, config, reuse, or buy would have
  solved it — this is the minimum-code priority order, not a suggestion.
- A boolean flag argument added "just for this one caller" — it is a second
  responsibility hiding inside the method signature.
