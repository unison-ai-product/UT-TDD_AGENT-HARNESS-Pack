---
schema_version: skill.v1
name: design-family-operations-reliability
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
decision_points:
  - when: "Authoring the monitoring/alert section of an operations design doc for a service."
    choose: "define each SLI with a numeric threshold and a multi-window burn-rate alert (e.g. 1h+6h) tied to a requirement ID"
    over: "writing a prose instruction such as \"strengthen monitoring\" with no numeric threshold table"
    because: "burn-rate windows exist specifically to suppress false-positive paging; a threshold-free instruction gives an implementer nothing to build an actual alert rule from, and the gap is invisible until the first noisy on-call rotation."
  - when: "A reliability / DR-BCP design states an RTO/RPO target for a failure scenario."
    choose: "require the same PLAN to schedule a recurring restore/failover drill that produces a dated evidence artifact, not just the target row"
    over: "accepting the RTO/RPO table entry alone as the design deliverable"
    because: "an RTO that has never been drilled is a hope, not a capability; a declared number and a verified number are different claims, and only the drill artifact closes that gap."
  - when: "An incident-management design defines a severity ladder (Sev1-Sev4)."
    choose: "make postmortem mandatory for Sev1/Sev2 with a named template and a tracked remediation-item list"
    over: "leaving blameless postmortem as an unstructured cultural bullet with no required artifact"
    because: "without a named template and a tracked item list, postmortem discipline decays into an unenforced norm the first time the on-call rotation is short-staffed — exactly when it matters most."
  - when: "A capacity/autoscale design sets a scale-up trigger (e.g. CPU, queue length, DB connections)."
    choose: "tie the trigger value to a load-test result from the performance test plan"
    over: "setting the threshold from intuition and revisiting it only after a capacity incident"
    because: "capacity planning and load testing are meant to be a closed loop; an untested threshold is discovered wrong exactly when load has already become a production problem."
  - when: "Writing an operational runbook or maintenance manual chapter intended for a non-author responder."
    choose: "write each procedure as an ordered, step-level sequence with the expected system state after each step, or explicitly cross-reference the doc that has that detail by ID"
    over: "writing a policy-level bullet that names a mode (e.g. \"縮退手順/告知\") without the steps"
    because: "a responder under time pressure who only has a policy bullet cannot execute; step-level detail (or an explicit ID-referenced pointer to where it lives) is what makes a runbook usable during an incident rather than only during a calm review."
  - when: "Designing the stop/resume/execution-log schema for a long-running or interruptible job."
    choose: "include an explicit idempotency-key field in the run journal itself, matching the idempotency policy stated elsewhere in the same doc"
    over: "stating \"idempotent retries\" as a policy bullet with no corresponding field in the journal's data model"
    because: "a policy with no matching field cannot be mechanically enforced or tested; the journal schema is the only place the idempotency guarantee can actually be checked at runtime."
  - when: "The product-pattern for the current PLAN is PoC / Discovery spike."
    choose: "write only the ops-design content needed to state and measure the PoC's single success criterion, and explicitly mark capacity planning, DR-BCP, and full incident/postmortem chapters \"out of scope for PoC\""
    over: "authoring the full operations/maintenance/DR-BCP/incident/capacity/runbook/stop-resume/support document set for a throwaway spike"
    because: "this document family assumes a production release under real availability, tenant, and audit obligations; applying that weight to a PoC adds process cost with no decision value, since a PoC is discarded or re-scoped before it needs a drilled DR plan."
  - when: "The product-pattern for the current PLAN is Enterprise (multi-tenant, contractual SLA, compliance obligations)."
    choose: "treat DR-BCP, incident/postmortem, and full operations design as mandatory-detailed, gate-blocking documents with real values, not optional templates"
    over: "leaving these chapters as low-effort placeholder bullets through to release"
    because: "an Enterprise product with a paid SLA and per-tenant blast radius is directly exposed to contractual and reputational risk the day a major incident happens without a drilled RTO/RPO, a defined severity ladder, and a working escalation matrix."
---

# design family: operations & reliability

Content requirements for the operations/reliability design-document family: what
each document must contain to be usable during a real incident or maintenance
window, and the omission pattern that tends to survive review and hurt later.
This skill governs document *content*, not the UT-TDD process around it — see
Boundary below.

## When to load this skill

- Authoring or reviewing any of: operations design, maintenance design,
  reliability/DR-BCP design, incident-management/postmortem design, capacity
  planning/autoscale design, runbook/maintenance-manual/training plan,
  stop-resume/execution-record design, or support/escalation design.
- An L11 ops-readiness or L10 non-functional gate is approaching and one of
  these documents is missing a required section.
- Deciding how much of this document family a PoC vs. an Enterprise PLAN
  actually needs (see the two product-pattern decision points above).

## Document-by-document requirements

### Operations design (monitoring, SLO, backup, incident, release/rollback, capacity)

- **Role**: the top-level operations contract — SLI/SLO with numeric
  thresholds, error-budget policy, backup/restore targets (RPO/RTO), severity
  and runbook index, release/rollback strategy, and capacity/cost posture in
  one document that other family documents specialize.
- **MUST contain**: an SLI table with numeric thresholds (not "adequate
  monitoring"); an SLO with a measurement window and an error-budget policy
  that maps remaining budget to a concrete release-freeze rule; backup/restore
  RPO/RTO per data class; a severity table with first-response targets; a
  release/rollback strategy including DB-migration compatibility mode
  (expand→migrate→contract).
- **Characteristic omission**: the error-budget *policy* table (spend rules)
  is often well specified while the capacity/cost chapter regresses to
  bullet-level generality with no quantified trigger — so the document reads
  as rigorous in its monitoring/SLO chapters and vague exactly where it hands
  off to the capacity-planning document, breaking the intended chain.

### Maintenance design (patching, dependency EOL, tech debt, handover)

- **Role**: post-release change management — corrective/adaptive/perfective/
  preventive maintenance categories, patch SLA by severity, dependency EOL and
  deprecation lifecycle, tech-debt tracking, and dev→ops handover checklist.
- **MUST contain**: a patch-SLA table keyed to CVE/defect severity; an EOL/
  deprecation lifecycle (Deprecated → Sunset grace → End-of-Life) with a named
  usage-metering signal that triggers the sunset decision; a handover
  checklist (config/access, procedures, contacts, known issues) completed
  before GA.
- **Characteristic omission**: the EOL lifecycle names the phases but the
  "usage-metering signal" that should trigger moving from Sunset to
  End-of-Life is described only as "利用状況を計測して停止判断" — a metric
  reference, not a metric ID — so the actual sunset trigger is undecidable
  from the document alone.

### Reliability / DR-BCP design (resilience patterns, failure modes, RTO/RPO, failover, DR drills, BCP)

- **Role**: the resilience and disaster-recovery contract — resilience
  patterns per failure mode (retry, circuit breaker, bulkhead, fallback,
  idempotency), RTO/RPO per DR scenario, failover procedure and recovery
  order, DR drill cadence, and business-continuity degraded-mode plan.
- **MUST contain**: an RTO/RPO table per scenario (single-AZ, region,
  data-corruption) with numeric targets; a failover procedure with an
  explicit recovery *order* (e.g. auth → data → billing → notification); a
  drill cadence with a named evidence artifact (not just "quarterly drills");
  a BCP section naming degraded-mode behavior and decision-makers.
- **Characteristic omission**: RTO/RPO numbers and the failover procedure are
  usually concrete, but the drill cadence is a single policy bullet
  ("四半期ごとにDR訓練を実施") with no required output artifact — so nothing
  in the document actually forces a drill to have happened, only to be
  planned. A declared RTO with zero drill evidence is the single most common
  way this document family fails silently until a real incident.

### Incident management / postmortem design (severity, on-call, postmortem, error budget)

- **Role**: the live-incident response contract — severity definitions,
  detection→triage→resolution→closure flow, on-call rotation, and mandatory
  postmortem discipline tied to the error budget.
- **MUST contain**: a full severity ladder (down to the lowest tier) with
  first-response-time targets; a response flow with a named incident
  commander role; an on-call rotation and handoff procedure; a postmortem
  requirement (which severities require it, on what deadline, with what
  template) and a tracked remediation-item list.
- **Characteristic omission**: severity and response-flow chapters are
  typically well specified, but "postmortem discipline" is stated as a bullet
  ("時系列/根本原因/再発防止をテンプレ化") without naming the actual template
  artifact or a tracking mechanism for the resulting action items — a promise
  to templatize, not a spec of the template.

### Capacity planning / autoscale design (demand model, autoscale policy, load-test linkage)

- **Role**: the growth and elasticity contract — demand forecast drivers,
  per-tier autoscale policy, and the explicit link to load testing that
  validates scale limits before they're needed in production.
- **MUST contain**: a demand-driver table (what grows what, e.g. tenant count
  × seats → concurrency) with a forecasting method; an autoscale policy per
  tier (app/worker/DB) with the triggering metric; an explicit load-test
  cadence tied to the performance test plan that validates the scale ceiling
  before real load reaches it.
- **Characteristic omission**: the autoscale-policy table names a triggering
  metric (CPU, queue length) but not a numeric threshold value, and the
  load-test linkage chapter is three bullets with no defined test frequency —
  so the "avoid over-engineering" caution in the policy chapter (present in
  source) is followed literally into under-specification: nothing here is
  numeric enough to gate a release.

### Runbook / maintenance manual / training plan (operational modes, per-role procedures, training)

- **Role**: the executable-procedure layer for operators — operating modes
  (normal/degraded/emergency/DR-site/maintenance), per-user-class procedures,
  and the training/drill cadence that keeps the procedures usable.
- **MUST contain**: step-level procedures per operating mode that a
  non-author can execute without asking a clarifying question; a per-role
  procedure map (system operator, support first-line, maintenance owner)
  naming which chapter of which document they follow; an onboarding and
  periodic re-drill training plan.
- **Characteristic omission**: this document is structurally an *index* —
  its own tables stop at naming a mode and a one-line summary ("縮退手順/告
  知"), then defer actual step detail to the incident-management, support, or
  release documents. That's a legitimate design if the cross-references are
  explicit IDs; the recurring failure is when the reference is only prose
  ("インシデント(62)連携") and the referenced chapter, when checked, turns out
  to also be bullet-level rather than step-level — so the detail a non-author
  actually needs exists nowhere in the family.

### Stop / resume / execution-record design (checkpoint, idempotency, run journal, recovery)

- **Role**: the interruption-safety contract for long-running or batch
  processes — checkpoint granularity, the run-journal schema, idempotency/
  dedup mechanism, and manual/automatic recovery procedure.
- **MUST contain**: a checkpoint design stating resume granularity (tenant /
  batch / record level); a run-journal schema with run_id, started/ended,
  processed/total, last_checkpoint, status, error, and — critically — an
  idempotency-key field; a recovery procedure distinguishing automatic retry
  from manual `run_id`-scoped resume; a reconciliation step (count/hash match
  before/after).
- **Characteristic omission**: idempotency is stated as a chapter-level
  policy ("冪等キーで二重処理を防止") but the run-journal schema chapter,
  specified independently, commonly has no idempotency-key column — the
  policy and the data model were designed in different chapters without being
  cross-checked, so the guarantee the policy promises has nowhere to actually
  be recorded or verified.

### Support / inquiry / escalation design (channels, triage, tiers, SLA, escalation matrix)

- **Role**: the customer-facing incident and inquiry funnel — intake
  channels, triage classification, L1/L2/L3 support tiers, response/
  resolution SLA by priority, and the escalation matrix into engineering and
  incident management.
- **MUST contain**: a channel table with coverage hours; a triage
  classification with priority mapping; an SLA table (first response +
  resolution target) per priority; an escalation matrix naming the *specific*
  trigger condition, the target tier/role, and the deadline; an explicit
  hand-off point into the incident-management document's severity IDs.
- **Characteristic omission**: the escalation matrix's "major incident" row
  is correctly present, but the link to the incident-management document's
  severity values is a one-line note ("障害は運用設計のSEVと連動") rather
  than a named ID mapping (e.g. "matrix row 3 = Sev1/Sev2") — two documents
  maintained by different authors will drift on exactly this seam unless the
  mapping is explicit.

## Product-pattern conditioning

This document family is heaviest for a production, multi-tenant, contractually-
obligated service. Scale it deliberately:

- **PoC / Discovery spike**: write only enough to state and measure the PoC's
  single success criterion. Explicitly mark capacity planning, DR-BCP, and
  full incident/postmortem chapters "out of scope for PoC" in the doc header
  rather than leaving them silently blank — a marked scope-out is a decision,
  a blank chapter is an unknown.
- **Enterprise**: DR-BCP, incident/postmortem, and full operations design are
  gate-blocking at L11/L12 with real numeric values. A placeholder bullet in
  any of these chapters at GA is a release blocker, not a follow-up item.

## Boundary

- **[[incident-runbook]]** (`skills/incident-runbook.md`) owns the UT-TDD
  *process*: the L11 gate check that a runbook exists with ≥3 alert
  procedures, and the live Incident-drive PLAN procedure (severity
  classification, timeline recording, post-incident Recovery PLAN). This
  skill owns what the runbook and the incident-management design document
  must *contain* as content — the two are paired, not duplicated.
- **[[ci-deploy-and-rollback]]** (`skills/ci-deploy-and-rollback.md`) owns the
  deploy-gate sequence and rollback procedure for harness releases and
  target-repo deploys. This skill's release/rollback content requirement
  (in the operations design document) is the design-time contract that
  `ci-deploy-and-rollback` executes against at deploy time.
- **[[harness-observability]]** (`skills/harness-observability.md`) owns
  `harness.db` projections and UT-TDD's own cross-runtime telemetry — an
  internal tooling concern. This skill's monitoring/SLI content requirement
  is about the *product's* operations design, not the harness's own state
  database.
