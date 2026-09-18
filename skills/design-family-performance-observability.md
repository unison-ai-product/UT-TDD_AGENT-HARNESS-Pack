---
schema_version: skill.v1
name: design-family-performance-observability
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L5
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
decision_points:
  - when: "A performance design doc states a target such as \"応答を高速化する\" (make responses fast) with no unit."
    choose: "rewrite every target as a number tied to a requirement ID (e.g. p95<300ms tied to NF-005)"
    over: "leaving adjective-only targets (\"fast enough\", \"良好な性能\") in the design doc"
    because: "only a numeric target traced to a requirement ID can be pass/fail-gated by the performance test plan; an adjective cannot be asserted against in a test."
  - when: "Writing the workload model for a performance test plan."
    choose: "state environment parity (same topology, comparable data volume/cardinality vs. production) as an explicit test precondition"
    over: "running the load test against a smaller or differently-shaped staging environment without recording the delta from production"
    because: "a passing test in a non-parity environment produces false confidence; the gap surfaces only in production under real load, which is exactly the failure this document family exists to catch before release."
  - when: "Defining Core Web Vitals targets and their regression alerting."
    choose: "state a numeric regression threshold and the owning team for the alert (e.g. \"LCP p75 field value regresses >10% week-over-week -> frontend on-call\")"
    over: "writing \"閾値超過をアラート化\" (alert on threshold breach) without naming the threshold value or the owner"
    because: "an unstated threshold cannot be implemented as an alert rule, and an alert with no named owner fires into silence — both failures are invisible until the first real regression ships unnoticed."
  - when: "Defining a KPI/metric that sits on the causal chain from a technical SLI to a business outcome (e.g. availability -> churn)."
    choose: "label it explicitly as a leading or lagging indicator and review leading indicators at a higher frequency than the lagging outcome they predict"
    over: "listing all KPIs in one flat table with no leading/lagging distinction and reviewing them on the same cadence"
    because: "the entire point of a causal KPI tree is early warning; a leading indicator reviewed only as often as the lagging metric it predicts has already lost the time advantage that justified building the tree."
  - when: "Adding a new field to the common log schema."
    choose: "check it against an explicit field-level masking list before merging, and add it to that list if it can carry PII or a secret"
    over: "relying on a chapter-level masking policy bullet (\"個人情報・秘密は出力前にマスキングする\") as an implicit blanket rule"
    because: "a policy stated only as prose with no explicit field list cannot be checked by a linter or a reviewer against a schema diff — it depends on someone remembering, which is exactly the gap that leaks PII into logs."
  - when: "Setting a rate-limit/quota noisy-neighbor detection trigger."
    choose: "cite the specific per-tenant metric ID from the KPI/metrics design that the detection rule reads"
    over: "describing detection as \"テナント別メトリクスで早期検知\" (detect early via per-tenant metrics) without naming which metric ID"
    because: "without a named metric ID, the rate-limit doc and the metrics doc can drift independently and the detection rule becomes either unimplementable or silently stale after the metrics doc changes."
  - when: "The product-pattern for the current PLAN is PoC / Discovery spike."
    choose: "measure only the PoC's single stated success criterion (one performance number or one KPI) and explicitly mark load testing, CWV optimization, full log/trace design, rate-limiting, and cost/FinOps chapters \"out of scope for PoC\""
    over: "authoring the full performance/test-plan/web-performance/KPI/log-trace/rate-limit/FinOps document set for a throwaway spike"
    because: "this document family assumes a production release under real multi-tenant load and cost pressure; applying that weight to a PoC blocks the spike on documentation that has no bearing on the PoC's binary decision question."
  - when: "The product-pattern for the current PLAN is Enterprise (paid SLA, multi-tenant, cost accountability)."
    choose: "treat performance-test environment parity, KPI leading/lagging labeling with owners, and cost/FinOps budget alerts as mandatory, gate-blocking, with real threshold values"
    over: "leaving these as bullet-level placeholder chapters through to GA"
    because: "the source documents price cost per tenant and target contractual SLA numbers; an Enterprise product that GA's with unlabeled KPIs, a non-parity perf test, and no cost budget alert carries both a reliability blind spot and a margin blind spot at the moment scale actually arrives."
---

# design family: performance & observability

Content requirements for the performance and observability design-document
family: what each document must contain to be a testable, traceable contract
rather than a set of good intentions, and the omission pattern that tends to
survive review and hurt later. This skill governs document *content*, not the
UT-TDD process around it — see Boundary below.

## When to load this skill

- Authoring or reviewing any of: performance design, performance test plan,
  web performance (Core Web Vitals) design, KPI/measurement design, log/trace
  design, rate-limit/quota design, or cost/FinOps design.
- An L10 non-functional gate is approaching and a performance or observability
  target is stated in prose rather than as a number.
- Deciding how much of this document family a PoC vs. an Enterprise PLAN
  actually needs (see the two product-pattern decision points above).

## Document-by-document requirements

### Performance design (cache / index / N+1 / pagination)

- **Role**: the response-time contract at the data-access layer — numeric
  performance targets per use-case, N+1/full-scan avoidance strategy, cache
  design with an explicit invalidation trigger, and pagination strategy for
  lists.
- **MUST contain**: a target table (p95/p99 latency) per use-case tied to a
  requirement ID — numbers, not adjectives; a data-access table naming the
  specific problem (N+1, full scan, hot path) and its mitigation; a cache
  table with target, mechanism, *and* invalidation trigger (TTL vs. event);
  a pagination rule (cursor/keyset, max page size, default sort).
- **Characteristic omission**: the target table is reliably numeric (this is
  the one chapter authors get right), but the cache-invalidation column is
  frequently bullet-level ("TTL/更新イベント") without stating which specific
  cache key or scope it applies to — an invalidation *mechanism* is named
  without an invalidation *scope*, which is exactly what causes stale-data
  bugs that are hard to reproduce because the design doc doesn't say what
  should have been invalidated.

### Performance test plan

- **Role**: the verification contract for the performance design — workload
  model (normal/peak/spike/sustained), pass/fail criteria per metric, and the
  environment the test runs against.
- **MUST contain**: a workload model covering at minimum normal, peak, spike,
  and sustained-load scenarios; a metrics table with numeric pass criteria
  sourced from a requirement ID; an explicit statement of **environment
  parity** — that the test environment matches production topology and data
  volume/cardinality closely enough that a pass is meaningful; a feedback loop
  stating what happens on failure (tune, re-test, gate release).
- **Characteristic omission**: workload scenarios and pass criteria are
  usually well specified, but environment parity is never stated at all —
  there is no chapter or field asserting "this test ran against a
  production-equivalent environment." This is the most consequential
  omission in the whole family: it is invisible in a green test result and
  only surfaces the first time production traffic behaves differently than
  the (unstated, possibly smaller) test environment did.

### Web performance design (Core Web Vitals)

- **Role**: the user-perceived performance contract — Core Web Vitals targets
  (LCP/INP/CLS) as numbers, optimization measures by area (JS/images/
  delivery/render), and the RUM + lab measurement pipeline that detects
  regression.
- **MUST contain**: a CWV target table with numeric "good" thresholds (e.g.
  LCP < 2.5s) tied to the performance requirement; an optimization measures
  table per area; a measurement chapter naming both field data (RUM) and lab
  data (CI Lighthouse-class tooling) with an explicit regression threshold
  and an alert owner.
- **Characteristic omission**: CWV targets are numeric (good), but the
  measurement chapter's regression-alerting line ("閾値超過をアラート化")
  repeats the same unstated-threshold, unnamed-owner gap seen elsewhere in
  this family — a measurement pipeline exists, but nothing in the doc commits
  to a specific regression percentage or a specific team that reacts to it,
  and no baseline-snapshot cadence is defined either.

### KPI / measurement design

- **Role**: the metrics contract linking business outcomes to product
  behavior to technical SLIs in one causal tree, with named metric IDs, event
  schemas, and dashboards per audience.
- **MUST contain**: a KPI tree spanning business (MRR/Churn/NRR/CAC-LTV),
  product (activation, retention, feature usage), and technical (SLI)
  layers with the causal linkage stated; a metrics table with metric ID,
  name, type (counter/gauge/histogram), unit, and collection source; an event
  schema (name, firing point, key properties) with a consistent naming
  convention; per-audience dashboards; a data-quality/privacy chapter
  (no direct PII in measurement, retention period, consent scope).
- **Characteristic omission**: metric IDs, types, and collection sources are
  reliably specified, and each metric has a "collection source" column — but
  there is no **owner** column (a named team/role accountable for the
  metric) and no **leading vs. lagging** classification, even though the KPI
  tree's own causal structure implies some SLIs are meant to be early
  warnings for business metrics like churn. Without that label, a leading
  indicator gets reviewed on the same cadence as the lagging metric it should
  be predicting, and the early-warning value the tree was built for is lost.

### Log / trace design

- **Role**: the structured-observability contract — log types and retention,
  common fields including correlation IDs, log-level policy, structured JSON
  format, distributed tracing, and the masking/retention boundary for PII and
  secrets.
- **MUST contain**: a log-type table (app/access/audit/batch/security) with
  distinct retention periods; a common-fields table including
  `request_id`/`trace_id` (correlation) and `tenant_id`; a log-level policy
  stating what ships to production (DEBUG suppressed, ERROR alerts); a
  structured JSON format example; a distributed-tracing design (trace_id
  propagation, sampling policy, always-sample-errors rule); and — critically
  — an explicit statement that PII, tokens, and card data are never logged in
  the clear, backed by a field-level masking list.
- **Characteristic omission**: correlation IDs, retention periods, and a
  "PII is masked" policy bullet are all reliably present — but the masking
  policy is stated once, generically, in a retention/masking chapter, with no
  explicit cross-reference back to the common-fields table that lists exactly
  which fields exist. A new field added to the common schema later (e.g. by a
  different author) has no mechanism forcing a masking-list update, so the
  policy and the schema silently diverge — the same cross-doc drift pattern
  that recurs across this whole document family.

### Rate limit / quota design

- **Role**: the tenant-fairness contract — per-tenant rate limits and quotas,
  noisy-neighbor detection and mitigation, and the exact behavior on limit/
  quota breach.
- **MUST contain**: a quota table (target, limiting axis, default per plan
  tier); a noisy-neighbor detection strategy naming the metrics it watches
  and the escalation path (throttle → tier upgrade → isolation, as a policy
  decision, not an auto-tuning knob); an overflow-behavior table (429 +
  Retry-After for rate breach, upgrade-prompt/billing-linkage for quota
  exhaustion, ops escalation for sustained breach).
- **Characteristic omission**: the overflow-behavior table is reliably
  concrete (429, Retry-After, specific next actions) — the gap is in the
  detection strategy, which says "テナント別メトリクスで早期検知" without
  naming the specific metric ID from the KPI/metrics design that the
  detection rule is supposed to read, leaving the trigger mechanism
  undecidable from this document alone.

### Cost design / FinOps

- **Role**: the cost-accountability contract — cost visibility by tenant/
  feature/environment, unit-economics definitions, budget alerting, and
  optimization policy, kept tightly coupled to pricing so margin is visible
  before it erodes.
- **MUST contain**: a cost-visibility table (dimension, allocation key,
  purpose) covering at minimum tenant and feature/component dimensions; a
  unit-economics table (cost per active tenant, gross margin, cost per seat)
  with an explicit definition per metric; a budget/alert chapter with a
  stated threshold *value* (percentage or currency amount) and a named owner
  per service budget; an optimization policy (reserved capacity, idle-
  resource reclaim, storage tiering).
- **Characteristic omission**: cost-visibility dimensions and unit-economics
  definitions are typically well specified, but the budget/alert chapter is
  bullet-level ("閾値で通知" — "notify at threshold") with no stated
  percentage or currency value and no explicit link from a cost anomaly to
  the incident/escalation process — so a real cost spike has a policy that
  says it will be noticed, but no number that defines "spike" and no named
  path to who acts on it.

## Product-pattern conditioning

This document family is heaviest for a production, multi-tenant, cost-
accountable service under a real SLA. Scale it deliberately:

- **PoC / Discovery spike**: measure only the PoC's single stated success
  criterion — one performance number, or one KPI. Explicitly mark load
  testing, CWV optimization, full log/trace design, rate-limiting, and cost/
  FinOps chapters "out of scope for PoC" rather than leaving them silently
  blank.
- **Enterprise**: performance-test environment parity, KPI ownership/leading-
  lagging labeling, and cost/FinOps budget alerts are gate-blocking at
  L10/L11 with real numeric values. A placeholder bullet in any of these
  chapters at GA is a release blocker.

## Boundary

- **[[harness-observability]]** (`skills/harness-observability.md`) owns
  `harness.db` projections, `model_runs` cost/token telemetry, and the
  UT-TDD session log/handover pipeline — the harness's *own* internal
  observability. This skill owns the *product's* performance, KPI, log/trace,
  rate-limit, and cost design content; the two are namespace-disjoint (product
  service vs. harness tooling) even though both use the word "telemetry."
- **[[incident-runbook]]** (`skills/incident-runbook.md`) owns the L11 gate
  process and live-incident procedure. Alert thresholds referenced by a
  runbook must trace back to *this* skill's log/trace and performance design
  content as their single source of truth — the runbook skill explicitly
  forbids duplicating threshold values inline for that reason.
- **[[ci-deploy-and-rollback]]** (`skills/ci-deploy-and-rollback.md`) owns
  deploy-time rollback triggers (error rate, p95 latency degradation vs.
  baseline). Those trigger *values* should be sourced from this skill's
  performance design and log/trace design content, not redefined ad hoc at
  deploy-gate time.
