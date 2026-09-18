---
schema_version: skill.v1
name: vmodel-stage-architecture
skill_type: design-contract
applies_to:
  layers:
    - L3
    - L4
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Reverse
decision_points:
  - when: "Choosing a multi-tenant (or other shared-resource) data-isolation strategy at basic-design stage"
    choose: "declare a double-defense scheme explicitly — a data-layer isolation policy (e.g. row-level security) AND an application-layer enforcement point (e.g. a repository-layer scope guard) — as its own named section, not folded silently into the DB design chapter"
    over: "relying on a single layer (policy-only or application-only enforcement) and treating isolation as an implementation detail left to whoever writes the repository code"
    because: "the source basic design gives tenant isolation its own top-level section specifically because a single point of failure in isolation is the highest-severity risk named at the charter stage; documenting it as a first-class basic-design decision, not an implementation afterthought, is what makes it reviewable before code exists."
  - when: "Producing the table/data-model list at basic design"
    choose: "list logical tables/entities and their primary relations and kind only, and explicitly defer physical column definitions (types, precision, constraints) to detailed design"
    over: "writing full physical column definitions at the basic-design stage"
    because: "the source basic design's table list explicitly notes physical columns are confirmed at detailed design, and the DB design doc treats logical-then-physical as a deliberate two-step order; collapsing them spends basic-design review cycles on details that will still change once detailed design starts."
  - when: "Deciding what belongs in an application-style/technical-conventions document versus leaving it to each module's detailed design"
    choose: "fix environment/charset/timezone/i18n conventions, the session/state model, logging conventions, and cross-cutting processing rules (pagination, optimistic locking, audit trail, retry policy) once, at basic design, as house rules every module inherits"
    over: "letting each module's detailed design invent its own charset, logging shape, or pagination convention independently"
    because: "these are cross-cutting decisions that must be uniform before detailed design starts; leaving them implicit means L5 authors diverge from each other, and inconsistency surfaces only once modules are integrated — too late to fix cheaply."
  - when: "Deciding where enum/code values, screen labels, i18n keys, and system email templates are defined"
    choose: "centralize them once in a shared design-catalog/definition-set document, referenced by DB, API, and screen design alike"
    over: "letting each screen or table locally define its own enum values or labels"
    because: "these values are explicitly shared across DB, API, and screen layers in the source design; redefining them locally is the same duplicate-definition drift that a glossary term redefined locally causes, just at the design-catalog level instead of the terminology level."
  - when: "Fixing the domain-model boundary as part of basic design"
    choose: "define bounded contexts, a context map (upstream/downstream relations, anti-corruption layers, published-language contracts), and aggregates with explicit invariants before producing class diagrams or directory structure"
    over: "jumping straight to a class list or a directory layout without first fixing context boundaries"
    because: "the class-design and directory-structure documents both already assume a settled 'domain layer' with fixed boundaries when they map classes and folders onto it; producing them before the domain model exists leaves nothing stable for that mapping to reference, and the mapping has to be redone once the boundaries are finally fixed."
  - when: "Fixing directory/project structure at basic design"
    choose: "make the intended dependency direction (inward-only: presentation to application to domain, with infrastructure implementing domain-owned ports) a structural rule enforced by lint/CI, not just a diagram in the directory doc"
    over: "documenting the intended layering in prose/diagram and trusting future contributors or an AI implementation agent to follow it"
    because: "the source directory design states circular dependencies are forbidden and checked by lint/CI as the actual mechanism — a documented convention with no machine check is exactly the gap this project's own document-plus-machine-enforcement principle exists to close."
  - when: "Scoping how much of the network/infra/DB-scaling design set to write for a PoC-scale project"
    choose: "skip detailed network segmentation, firewall/security-group rule tables, and partitioning/scale-headroom sections; write only the minimum system-decomposition diagram and a single-environment table list"
    over: "producing the full network design, infra design, and DB partitioning documents as if the PoC were a production multi-tenant SaaS"
    because: "a PoC's basic design only needs to validate its hypothesis, not survive production load or a security audit; the segment/rule/partition detail these documents carry exists to support scale and compliance concerns a PoC does not yet have, and writing it anyway is the Enterprise-weight-by-default mistake this project's tailoring guidance already warns against."
  - when: "Choosing the deployment/session/infrastructure shape at basic design for a non-web platform (CLI, desktop, embedded) instead of a multi-tenant web SaaS"
    choose: "replace the CDN/load-balancer/stateless-app/shared-database decomposition and JWT-session model with whatever boundary the actual platform has (e.g. local process and local storage for a CLI/desktop tool), rather than keeping the web-SaaS shape by default"
    over: "copying the web-SaaS system-construction pattern (CDN to load balancer to stateless app tier to shared database, session managed as a JWT) onto a project that has no browser client or multi-tenant session to isolate"
    because: "the system-construction chapter and the application-style spec's execution-environment section are themselves scoped to a specific platform (cloud multi-tenant SaaS); a CLI or desktop project has no tenant/session/CDN boundary to isolate, so this stage's requirement is to decide *the platform-appropriate decomposition*, not to reuse the source's web-SaaS content verbatim."
---

# vmodel stage: architecture (basic design)

What the basic-design stage of the V-model (source level L4) must fix before
detailed design and implementation begin. Basic design is where "what the
system must do" (frozen at the upstream requirements stage — see
[[vmodel-stage-upstream]]) becomes "how the system is decomposed": module/
component boundaries, application style, domain model, database and
infrastructure outline, and project structure. It stops short of physical
column definitions, class-level method bodies, and infrastructure-as-code —
those belong to detailed design (L5) and implementation.

## When to load this skill

- Starting or reviewing a basic-design pass for a new system or a
  significant architectural slice of one.
- Deciding what belongs in basic design versus detailed design (e.g. whether
  a table's physical columns should be defined yet).
- Fixing the domain model, bounded contexts, or directory/project structure
  for a project and it is unclear what basic design is expected to settle
  versus leave open.
- A basic-design document set is missing a section and it is unclear whether
  that is a real gap or intentionally deferred to detailed design.
- Scoping how much of the infra/network/DB-scaling apparatus a given
  project's scale or platform actually needs at this stage.

## What basic design must fix

Basic design fixes structure, not implementation detail, across these
concerns:

### System decomposition and tenant/isolation

The system-construction chapter names every architectural layer/component
(edge/CDN, load balancer, application tier, database, async
queue/worker, object storage, external SaaS dependencies) and each
component's role. Where the system shares a resource across tenants or
equivalent isolation boundaries, isolation gets its own explicit section: the
isolation mechanism (e.g. row-level security) plus the enforcement point that
backs it up (e.g. an application-layer scope guard), not one or the other
alone.

**Common omission:** documenting only the happy-path component diagram and
leaving isolation/security enforcement to be inferred from the database
design chapter.

### Application style

A dedicated application-style specification fixes the cross-cutting technical
conventions every module inherits: execution environment (target platforms,
environment tiers), charset/timezone/i18n conventions, session/state
management model, logging conventions (structured format, correlation IDs,
PII masking), and common processing rules (pagination shape, concurrency
control, audit-trail hooks, exception/retry policy).

**Common omission:** leaving logging shape or pagination convention
unspecified and letting each detailed-design author invent their own, which
then has to be reconciled during integration.

### Design catalog / shared definitions

A shared design-catalog document centralizes enum/code values, screen
labels and i18n keys, system email templates, database views, files, and
report specifications, and external-interface detail specs — anything
referenced by more than one of DB design, API design, and screen design.

**Common omission:** letting a screen or a table locally define its own enum
values instead of referencing the catalog, causing drift the first time the
value set changes.

### Domain model (DDD)

The domain-model document fixes ubiquitous language, bounded contexts, a
context map (upstream/downstream relations, anti-corruption layers,
published-language contracts between contexts), aggregates with their
invariants, entities/value objects, domain events (named in the past tense),
and the rule that a repository/domain-service boundary equals a transaction
boundary equals an aggregate boundary.

**Common omission:** skipping the context map and aggregate/invariant table
and going straight to a class list — the class list then has nowhere stable
to reference for "what belongs together."

### Database design outline

Database design at this stage fixes logical entities, primary keys and
relations, the normalization policy (default normal form, with named
exceptions for aggregation/reporting), the multi-tenant/isolation data
model, index policy at the level of "which columns lead the composite index"
(not the full physical index spec), partitioning/scale headroom as a stated
option (not yet implemented), and backup/recovery targets. Physical column
definitions are explicitly out of scope here.

**Common omission:** writing full physical table definitions at this stage,
which then get silently revised at detailed design without the revision
being tracked as a real design change.

### Network and infrastructure outline

Network design fixes segmentation (which components sit in which network
tier and whether they are externally reachable), the inter-component
communication matrix (protocol/port per pair), firewall/security-group
rules, DNS/TLS posture, and load-balancer/CDN/WAF placement. Infrastructure
design fixes the server/component list, middleware list, capacity/sizing
policy (including the redundancy target, e.g. "tolerate one instance loss"),
high-availability/failover approach, scaling triggers, and the
configuration-management (IaC) policy.

**Common omission:** describing components and their roles but never
producing the communication matrix, so the firewall/security-group rules
that should be derived from it are either missing or invented ad hoc later.

### Directory / project structure

The directory/project-structure document maps architectural layers
(presentation, application, domain, infrastructure, shared) onto concrete
repository directories, fixes naming conventions, states where
config/tests/docs/IaC live, and fixes the dependency direction (inward-only)
as a structural rule.

**Common omission:** documenting the intended dependency direction in prose
without wiring a lint/CI check that actually enforces it, so the rule
silently erodes as the codebase grows.

### Common components / class design

The common-component and class-design document fixes the layer
responsibilities (presentation → application → domain → infrastructure),
the class list with each class's layer and primary dependency, method-level
pre/postconditions and exceptions for key operations, a catalog of shared
components (cross-cutting utilities used by multiple modules), and the
reuse/dependency rules (dependency injection over direct instantiation, no
circular dependencies, domain layer depends on ports it owns, not on
infrastructure implementations directly).

**Common omission:** listing classes and methods without stating the
reuse/dependency rules, leaving "which direction may depend on which" to be
inferred rather than declared.

## Stage exit criteria / handoff to detailed design

Basic design is done, and detailed design (L5) can begin, when:

- Every ID this stage defines (screen, API, batch/async job, table) declares
  its trace back to the functional or non-functional requirement ID it
  implements — an ID with no traced-from requirement is a design element
  with no requirement backing it.
- The tenant/isolation double-defense (or equivalent isolation scheme) is
  documented as its own section, not implied by the DB design alone.
- The domain model's bounded contexts and aggregates are fixed before the
  class list and directory structure reference "the domain layer" as if it
  were already settled.
- The dependency-direction rule in the directory-structure document has a
  corresponding lint/CI check, not just prose.
- Integration-level test design (the level paired with basic design) can be
  written against this stage's component/API/batch decomposition without
  needing to guess at physical column definitions or infrastructure-as-code
  detail that basic design deliberately deferred.

## Product-pattern conditioning

- **PoC scale**: skip detailed network segmentation, firewall/security-group
  rule tables, and DB partitioning/scale-headroom sections. Produce only the
  minimum system-decomposition diagram and a single-environment table list —
  a PoC's basic design validates a hypothesis, not production scale or
  audit readiness.
- **Standard scale**: produce the full set above — system decomposition,
  application style, design catalog, domain model, DB/network/infra
  outlines, directory structure, and class design — each traced back to its
  requirement IDs.
- **Enterprise scale**: everything in Standard, plus the audit-facing and
  ops-facing documents this stage feeds (security design, privacy design,
  incident-response/DR design) written in full, not thinned under time
  pressure, because this is the layer those documents' architectural
  assumptions are derived from.
- **Platform conditioning**: the source system-construction and
  application-style content (CDN, load balancer, stateless app tier, shared
  database, JWT session) is scoped to a multi-tenant web SaaS. For a
  different platform (CLI, desktop, embedded, single-tenant service),
  produce the *platform-appropriate* decomposition and session/state model
  at this stage rather than reusing the web-SaaS shape by default — the
  requirement is that this stage decides the actual boundary, not that it
  reproduces a specific reference architecture.

## Boundary with existing skills

- **[[vmodel-stage-architecture]] (this skill)** covers what the basic-design
  document set must each produce, the boundary between basic design and
  detailed design, and this stage's exit criteria — not how any individual
  document is diagrammed or frozen for readability.
- **[[vmodel-stage-upstream]]** covers the planning/demand/requirements stage
  that this stage's IDs (screen, API, batch, table) trace back to. Basic
  design assumes requirements are already frozen; it does not re-elicit them.
- **[[design-doc]]** governs diagram sourcing (Mermaid vs D2) and diagram
  obligations once a basic-design document's scope is fixed — e.g. the
  module-component diagram and ER diagram this stage requires are produced
  under that skill's rules, not this one's.
- **[[spec-driven-development]]** governs the L5 detailed-design spec
  contract that unit- and integration-test design pair against, once basic
  design's component/API/table decomposition has already been frozen here.
- **[[design-tailoring-and-granularity]]** governs the general which-docs
  and how-much-detail judgement (todo/na, PoC/Standard/Enterprise
  granularity) that this skill's product-pattern conditioning section
  applies specifically to the basic-design (L4) stage.

## Anti-patterns

- Folding tenant/isolation enforcement silently into the DB design chapter
  instead of giving it its own explicit, reviewable section.
- Writing full physical column definitions at basic design instead of
  deferring them to detailed design.
- Letting each module's detailed design invent its own charset, logging
  shape, or pagination convention instead of fixing them once at this stage.
- Letting a screen or table locally define enum values or labels instead of
  referencing the shared design catalog.
- Producing a class list or directory structure before the domain model's
  bounded contexts and aggregates are fixed, leaving both with no stable
  boundary to reference.
- Documenting the dependency-direction rule in prose without a lint/CI check
  enforcing it.
- Producing the full network/infra/partitioning document set for a PoC-scale
  project, or reusing the web-SaaS system-construction pattern verbatim for
  a non-web-SaaS platform.
