---
schema_version: skill.v1
name: incident-runbook
skill_type: process
applies_to:
  layers:
    - L6
    - L11
    - L12
    - L13
    - L14
  drive_models:
    - Forward
    - Incident
    - Recovery
decision_points:
  - when: "L11 gate approaches and the runbook has fewer than 3 alert procedures, or lacks rollback/escalation sections"
    choose: "block the L11 gate and require the missing runbook sections before proceeding"
    over: "let the gate pass with a partial runbook and add sections later"
    because: "the L11 gate fails without all three required sections, and a responder without a complete runbook has no authoritative reference during a live incident"
  - when: "an incident symptom has no matching procedure in the existing runbook"
    choose: "escalate to the TL and add the new procedure as a required post-incident action"
    over: "improvise a mitigation directly in production"
    because: "improvising in production without a recorded procedure risks an unaudited, unverified change during an active incident"
  - when: "a runbook needs alert thresholds"
    choose: "reference the observability design doc as the single source of truth"
    over: "duplicate the threshold values inline in the runbook"
    because: "duplicated thresholds drift from the design doc and become silently wrong after the next observability change"
  - when: "root cause investigation after an incident reveals a code or design defect"
    choose: "open a Recovery PLAN with a regression test that would have caught the defect"
    over: "close the incident once the immediate mitigation is applied"
    because: "a mitigation without a regression test leaves the same defect exploitable on the next occurrence"
  - when: "classifying incident severity during first response"
    choose: "use the defined Sev1/Sev2/Sev3 thresholds (primary-path-down or data-loss vs. major degradation vs. minor)"
    over: "assign severity based on subjective urgency in the moment"
    because: "inconsistent severity classification breaks the escalation chain, which is keyed to severity-triggered roles"
---

# incident runbook

A runbook is written before an incident, not during one, so the responder has a
single authoritative reference. This skill covers (A) pre-release runbook
authoring as an L11 ops-readiness obligation and (B) the UT-TDD Incident drive
procedure for live production incidents (FR-L1-16).

## When to load this skill

- A PLAN approaches the L11 gate (system test / ops readiness) and no runbook
  exists for the service.
- A PLAN with the Incident drive is opened from a production signal.
- `ut-tdd doctor` surfaces a production-incident / regression / hotfix signal.

## Part A: pre-release runbook (Forward / Add-feature)

Save runbooks to `docs/ops/<service-slug>-runbook.md`. Three required sections
(the L11 gate fails without all three):

1. **Alert response** — ≥3 named alerts, each with trigger threshold, scope,
   immediate mitigation, recovery-confirmation check, and follow-up.
2. **Rollback** — trigger conditions, step-by-step rollback, data-integrity
   check, recovery-confirmation metric.
3. **Escalation chain** — roles (on-call → TL → PM/PO), not personal names, each
   with the condition that triggers it.

Thresholds are sourced from the observability design doc (single source of
truth) — do not duplicate threshold values. Record the runbook in the PLAN
`generates` list.

## Part B: Incident drive (live production)

Entry conditions for an Incident-drive PLAN: the signal is a production
incident / regression / hotfix; the target is production; and human approval
(on-call + TL + PM) is recorded before any production change.

```
ut-tdd status        # confirm current mode / drive / active PLAN (read-only; registers nothing)
```

First response (first ~15 minutes): confirm the symptom and scope; classify
severity (Sev1 primary-path-down or data-loss-risk; Sev2 major degradation;
Sev3 minor); open the runbook and follow the matching alert procedure; apply the
runbook's immediate mitigation if safe; record every action with a timestamp in
`.ut-tdd/audit/<plan-id>-incident-timeline.md`.

If no runbook procedure covers the symptom: do not improvise in production —
escalate to the TL, and add the new procedure to the runbook as a required
post-incident action.

## Post-incident

1. Update the runbook with the procedure that was exercised.
2. Open a Recovery PLAN (branch `hotfix/*`) if root cause needs a code/design
   fix; classify as `add-design` (design-level) or `add-impl` at L7
   (implementation-only); add a regression test that would have caught it.
3. Run `ut-tdd handover` to record the resolution at the session boundary.

## Completion checklist

- [ ] Runbook present at `docs/ops/<service-slug>-runbook.md` with ≥3 alert
      procedures, a rollback procedure, and a role-based escalation chain.
- [ ] Thresholds reference the observability design doc (no duplicate SSoT).
- [ ] Incident timeline recorded in `.ut-tdd/audit/`.
- [ ] Three-party approval recorded before any production change.
- [ ] Recovery / add-design PLAN opened for root cause; `ut-tdd handover` run.
