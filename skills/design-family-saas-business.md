---
schema_version: skill.v1
name: design-family-saas-business
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
    - L4
  drive_models:
    - Forward
    - Add-feature
    - Discovery
decision_points:
  - when: "the project is a single-tenant internal tool or a PoC and the design-doc scaffold includes billing/metering, tenant-lifecycle, SLA/catalog, region/residency, identity-provisioning, or compliance-mapping topics"
    choose: "mark all six SaaS-business docs `na` (structurally absent) and record the reason once in the tailoring note per [[design-tailoring-and-granularity]]"
    over: "writing thin stub versions of these docs because the template lists them"
    because: "a single-tenant tool has no second tenant to isolate, meter, or SLA-commit to; forcing the topic into existence manufactures a decision that does not exist, which is the false-`na`-in-reverse failure this skill's parent judgement exists to prevent."
  - when: "the project is Enterprise-scale or serves regulated/multi-tenant customers and any of tenant-lifecycle, SLA/catalog, or compliance-control-mapping is missing from the design-doc set"
    choose: "treat the missing doc as a blocking gap before pair-freeze on any feature that touches tenant data, billing, or a customer-facing commitment"
    over: "deferring these docs to a later hardening pass because the feature itself seems to work in isolation"
    because: "these three docs are where tenant-boundary and money-movement invariants get written down before code exists; a feature built against the app in isolation without a lifecycle/compliance doc to check against has no boundary contract to test."
  - when: "a billing-flow design describes a retry policy for a payment or usage-sync call without stating whether the retried operation is idempotent"
    choose: "require an explicit idempotency-key column or field in the flow before accepting the design"
    over: "assuming the payment provider's own retry safety covers the internal usage-to-charge conversion step"
    because: "the metering doc separates measured usage from the billing conversion step precisely so usage stays the source of truth; a retried conversion without an idempotency key double-applies that conversion even if the payment provider itself is idempotent, producing a double charge no test on the provider integration alone would catch."
  - when: "a tenant-lifecycle design defines an offboarding/deletion state but the design doc's delete step ends at 'mark records deleted' or 'call delete API'"
    choose: "require the design to name the purge-proof mechanism (a scheduled physical-delete job, an audit query, or an attestation record) and its own test target"
    over: "treating the presence of a delete state transition in the state table as evidence the data is actually gone"
    because: "a state-machine diagram proves a status flag changed, not that physical data, backups, and derived indexes were purged; deletion is the textbook case of a design that reads as complete but was never proven, and per [[test-breakage-thinking]] boundary-crossing and irreversible operations are exactly where test depth must concentrate, not skip."
  - when: "an SLA/service-catalog design states a numeric commitment (uptime %, response-time percentile, incident response time)"
    choose: "require the doc to name the specific monitor or metric source that measures that exact commitment before the SLA is accepted as designed"
    over: "accepting the numeric target as sufficient because it appears in a table with a 'measured by' column label"
    because: "a declared SLA number with no named, existing monitor is an unenforceable promise — the gap surfaces only when a customer disputes a breach and no measurement exists to confirm or refute it, which is the characteristic and costly failure mode for this document family."
  - when: "a non-functional requirement grid (e.g. ISO/IEC 25010-style) has a quality characteristic row with a target column filled by a qualitative word ('高い', 'good', 'sufficient') instead of a number"
    choose: "reject the row as incomplete and require a measurable numeric target or an explicit `TBD` routed to the debt register"
    over: "accepting the qualitative word as satisfying the grid's coverage purpose"
    because: "the grid's entire purpose is to prevent NFR omission by forcing every quality characteristic to a checkable target; a qualitative word satisfies the letter of 'row filled' while defeating the grid's actual function, which is to make every target testable."
  - when: "an identity-provisioning design covers SSO/SCIM onboarding (JIT creation, directory sync) in detail but the offboarding/deprovisioning step is a single unelaborated bullet"
    choose: "treat offboarding as equally load-bearing as onboarding and require the same level of design detail — trigger, timing, and what access is revoked when"
    over: "treating onboarding completeness as sufficient because it is what new customers experience first"
    because: "a stale account from an unfinished offboarding design is a live access-boundary risk with no visible symptom until an ex-employee or ex-partner successfully authenticates; onboarding gets reviewer attention because it is demoed, offboarding does not, which is exactly why it is the doc's characteristic omission."
  - when: "a compliance/control-mapping design lists a control area and a design/requirement ID it maps to, but the 'evidence' column names a document instead of a verifiable artifact (a log format, a query, an attestation record)"
    choose: "require the evidence column to name a concrete, retrievable artifact per control row before the mapping is accepted as complete"
    over: "accepting a reference to another design document as sufficient evidence for the control"
    because: "an auditor asks for the artifact, not the design intent; a control row whose evidence is 'see doc 68' produces no artifact on demand, and the mapping's whole purpose is to make evidence retrieval mechanical, not another design document to re-derive."
---

# design family: saas business (multi-tenant commercial layer)

The design-doc family covering the parts of a product that exist because it is
sold, multi-tenant, and/or regulated, rather than because of what the product
does functionally: billing/metering/entitlement, tenant lifecycle, the
non-functional-requirement coverage grid, region/data-residency strategy,
customer SLA/service catalog, identity provisioning (SSO/SCIM), and
compliance/control mapping. This skill governs what each of these docs must
contain to be usable and names the omission each one characteristically
develops when written under time pressure.

## When to load this skill

- Scoping the design-doc set for a project that has (or is adding) paying
  customers, multiple tenants, or a regulated customer base — after
  [[design-tailoring-and-granularity]] has already decided this family is in
  scope, not out of scope.
- Reviewing a billing, tenant-lifecycle, SLA, identity, region, or compliance
  design doc before it crosses pair-freeze.
- A feature PLAN touches usage metering, tenant deletion, an SLA-bearing
  endpoint, SSO/SCIM, or a compliance control, and the corresponding design doc
  either does not exist or is thin.
- Deciding test-depth allocation for this family (see the boundary section
  below and [[test-breakage-thinking]]).

## Product-pattern conditioning (read before writing any doc in this family)

This family is structurally about multi-tenant commercial operation. Whether
each doc belongs in the project's design set is decided by
[[design-tailoring-and-granularity]] Step 2 (`todo` vs `na`), but this skill
adds the concrete conditioning for this specific family:

- **Single-tenant internal tool or PoC** — all six docs below are correctly
  `na`. There is no second tenant to isolate, no external customer to bill or
  SLA-commit to, and no external audit to map controls for. Do not write thin
  stubs to satisfy a coverage template; that manufactures a decision that does
  not exist for the project.
- **Enterprise or regulated SaaS with paying/multi-tenant customers** —
  tenant-lifecycle, SLA/service-catalog, and compliance-control-mapping are
  mandatory, not optional even under time pressure, because they are where the
  tenant-boundary and money/compliance invariants are written down before code
  exists. Billing/metering, region/residency, and identity-provisioning are
  mandatory whenever the corresponding capability (paid plans, cross-region
  customers, or SSO/SCIM) is present, using the same test.

## What each document must contain

### Billing / metering / entitlement design
Role: separates measured usage (source of truth) from the billing conversion
step, and gates feature access by plan.

Must contain:
- What is metered per plan axis (seat count, API calls, storage, task volume)
  and the collection source and aggregation window for each metric — not a
  vague "usage" line.
- The billing flow as discrete steps (usage aggregation -> billing
  confirmation/sync -> payment -> revenue recognition), each naming its
  idempotency mechanism, because usage-to-charge conversion is the step most
  likely to be retried under transient failure.
- The refund/dispute path with its calculation basis (e.g. pro-rated by unused
  period), not just "refunds are handled."
- The entitlement (feature-gate) table mapping plan tier to feature access, and
  the grandfathering rule for existing tenants when a plan is repriced.

Characteristic omission: a retry policy exists at the payment-provider level
but the internal usage-to-billing conversion step has no idempotency key,
so a retried sync double-applies usage and double-charges the tenant — a bug
that never appears in provider-integration tests because the provider itself
behaved correctly.

### Tenant lifecycle design
Role: the state machine and procedure for a tenant's full life — creation,
suspension, tier change, and deletion — isolated from the tenant-facing request
path (control plane vs application plane).

Must contain:
- The full state table (e.g. pending -> provisioning -> active ->
  suspended/offboarding -> closed) with explicit failure/rollback transitions,
  not just the happy path.
- Idempotency and compensation for every provisioning step, so a partially
  created tenant is never left `active`.
- The offboarding/deletion procedure naming: retention/grace period, the
  physical deletion mechanism for each data category (application data,
  backups, audit logs), and — critically — the purge-proof mechanism (a
  scheduled job, an audit query, or an attestation artifact), not just a state
  transition to `closed`.

Characteristic omission: the state diagram shows a transition into a
`deleted`/`closed` state and the doc stops there. Deletion is designed as a
status flag flip, and nobody ever proves the backup copies, derived indexes,
or downstream caches were actually purged — this surfaces only during an
audit or a data-subject deletion-request dispute, long after the feature
shipped.

### Non-functional requirement (NFR) coverage grid design
Role: a systematic sweep (e.g. against ISO/IEC 25010 quality characteristics)
to catch NFR categories nobody thought to write a requirement for.

Must contain:
- Every quality characteristic row mapped to an existing requirement ID, or
  explicitly flagged unmapped.
- A numeric, measurable target per mapped row (e.g. "p95 < 300ms", "99.9%
  uptime", not "high performance" or "acceptable").
- An explicit TBD section for characteristics with no current requirement,
  routed to the debt register per [[design-tailoring-and-granularity]] rather
  than silently dropped.

Characteristic omission: a row gets filled with a qualitative word to make
the coverage template look complete, satisfying "the cell is not empty" while
defeating the grid's actual purpose — every target must be testable, and a
qualitative word is not.

### Region strategy / data residency design
Role: defines where each category of tenant data may physically live, and
keeps tenant placement a matter of routing configuration rather than
application behavior change.

Must contain:
- The regional deployment model (single-region, multi-region cell, dedicated
  cell for regulated tenants) and which tenants map to which model.
- Per-data-category residency rules (personal data pinned to region, backups
  within the same jurisdiction, logs/metrics allowed to cross borders only if
  anonymized).
- The tenant-to-region routing/resolution mechanism and the invariant that
  re-placing a tenant changes configuration, not application logic.

Characteristic omission: the residency rule is written as policy prose
("personal data stays in-region") but no job/cache/queue in the actual
implementation carries a region or tenant key, so a background job silently
processes data cross-region with no design-level flag that would have caught
it.

### Customer SLA / service catalog design
Role: the external, customer-facing commitment set — distinct from internal
SLOs — tied to measurable indicators and service-credit consequences.

Must contain:
- A service catalog naming each service and which tier it is available to.
- SLA/SLO indicators with numeric targets (uptime %, response-time
  percentile, incident-response time) and, for each, the specific measurement
  source (which monitor, which metric).
- The service-credit schedule mapping missed-target ranges to remediation.

Characteristic omission: a numeric SLA is declared in the doc with a
"measured by" column that names a category ("monitoring") rather than a
specific existing monitor — the commitment is unenforceable and undisputable
in either direction because nothing was ever wired to measure it.

### Identity / provisioning design (SSO/SCIM)
Role: the tenant-scoped authentication and directory-sync design — SSO/IdP
connection, SCIM/JIT user provisioning, and organization-scoped RBAC.

Must contain:
- SSO protocol and tenant-discovery mechanism (how a login is routed to the
  correct IdP).
- Provisioning methods (SCIM directory sync, JIT on first login, invite-only)
  each described with the same level of detail.
- The offboarding/deprovisioning path: what triggers revocation, how fast,
  and what access is cut — described with the same rigor as onboarding, plus
  the group-to-role mapping kept tenant-scoped.

Characteristic omission: onboarding (SSO login, JIT creation) is fully
detailed because it is demoed to customers; offboarding is a single bullet
("leavers deprovisioned") with no trigger or timing, leaving stale accounts as
a live, invisible access-boundary risk.

### Compliance / control mapping design
Role: maps applicable regulatory/standard requirements (SOC2, ISO 27001, data
protection law) to concrete controls and the evidence that proves each control
operates.

Must contain:
- The target standards/regulations list and their primary concern.
- A control-area table mapping each control to the design/requirement ID that
  implements it and the evidence artifact that proves it operates.
- The audit-trail preservation policy: tamper-evidence mechanism and
  retention period tied to legal/contractual requirement.

Characteristic omission: the evidence column names another design document
("see tenant-lifecycle design") instead of a retrievable artifact (a log
format, a query, an attestation record) — an auditor asking for evidence on
demand gets a pointer to more design intent, not proof the control ran.

## Boundary with existing skills

- **[[design-tailoring-and-granularity]]** decides *whether* this whole family
  belongs in a given project's doc set (the PoC/single-tenant `na` case) and
  *how much detail* each doc needs at the project's declared scale. This skill
  assumes that scoping decision is already made and specifies *what each doc
  in the family must contain* and its characteristic failure mode.
- **[[security-and-hardening]]** covers the systematic dependency/secret/lint
  hardening sweep applied at L7+ before accept. This skill covers *design-time*
  content requirements for the business/compliance doc family — the two are
  non-overlapping: a compliance-mapping design doc being complete does not
  substitute for the hardening sweep, and a clean hardening sweep does not
  substitute for a missing purge-proof mechanism in the tenant-lifecycle doc.
- **[[test-breakage-thinking]]** governs test-depth allocation generally,
  including the "irreversible operations, boundary crossings" prioritization
  this skill's decision points repeatedly cite for billing and tenant-deletion
  targets. This skill identifies *which design gaps in this family* create
  those irreversible-class risks; test-breakage-thinking governs how test
  effort is then allocated against them.

## Anti-patterns

- Writing thin stub versions of all six docs for a single-tenant PoC because a
  template lists them — mark `na` instead, per
  [[design-tailoring-and-granularity]].
- Accepting a tenant-deletion design that ends at a state-machine transition
  without naming a purge-proof mechanism.
- Accepting an SLA number with no named monitor as "measured."
- Filling an NFR grid row with a qualitative target word instead of a number.
- Detailing SSO/SCIM onboarding fully while leaving offboarding as an
  unelaborated bullet.
- Accepting "see design doc N" as the evidence artifact in a compliance
  control-mapping row.
- Treating a retried billing/usage-sync call as safe because the payment
  provider is idempotent, without an idempotency key on the internal
  usage-to-charge conversion step itself.
