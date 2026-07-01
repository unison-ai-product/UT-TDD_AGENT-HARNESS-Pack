---
schema_version: skill.v1
name: requirements-handover
skill_type: process
applies_to:
  layers:
    - L1
    - L3
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
    - Reverse
    - Recovery
---

# requirements handover

How to pass the requirements baton across sessions, agents, and layer
boundaries in UT-TDD (FR-L1-42 provider handover, FR-L1-31 context
continuity). The baton is a machine-readable JSON snapshot plus a
human-readable carry list — both must be consistent with real PLAN and git
state at the moment of handover.

## When to load this skill

- A session is ending and at least one L1 or L3 PLAN is still `active`.
- An agent is handing off an L1 elicitation or L3 requirement-authoring task
  to a successor agent or session.
- `ut-tdd handover` output needs to be verified for stale carry items before
  it is written.
- A Discovery S4 decision outcome must be forwarded into an L3 requirement
  before Forward implementation begins.
- `ut-tdd doctor` flags `.ut-tdd/handover/CURRENT.json` as stale or missing.

## The handover record: CURRENT.json

`.ut-tdd/handover/CURRENT.json` is the canonical baton. Fields relevant to
requirements handover:

```json
{
  "session_id": "...",
  "timestamp": "2026-06-17T10:00:00Z",
  "active_plans": ["PLAN-L1-NN", "PLAN-L3-NN"],
  "carry": [
    {
      "id": "C-01",
      "description": "L3 requirement FR-L1-42 not yet back-filled from Add-feature",
      "plan_ref": "PLAN-L3-NN",
      "status": "open",
      "verified_against": "git log + ut-tdd status 2026-06-17"
    }
  ],
  "blocked": [],
  "context_snapshot": "..."
}
```

Every carry item must have a `verified_against` note that names the command
and date used to confirm the item is genuinely open — not copied from a prior
handover without re-verification.

## L1 -> L3 requirement baton procedure

The L1-to-L3 descent is the highest-risk handover in Forward drive because an
ambiguous FR at L1 that lands in L3 without clarification will propagate
through L4-L7 as a silent design gap.

Checklist before passing the baton:

- [ ] Each FR in the L1 elicitation has a unique, stable ID (FR-L1-NN).
- [ ] Every FR that requires implementation has a corresponding PLAN in
  `docs/plans/` (or a `draft` stub explaining why it is deferred).
- [ ] Ambiguous FRs carry a `clarification_pending` marker and a linked
  open question in the PLAN `review_evidence` field — not left in prose.
- [ ] `ut-tdd plan lint` exits 0 on all L1 and L3 PLANs being handed off.
- [ ] `ut-tdd doctor` exits 0 — no orphaned FRs, no broken PLAN dependencies.
- [ ] `ut-tdd handover` has been run and `.ut-tdd/handover/CURRENT.json`
  reflects the current state.

## Context continuity (FR-L1-31)

A successor agent or session must be able to reconstruct context from the
handover record alone — without relying on the prior agent's chat history.

To ensure this:

1. The PLAN `review_evidence` field must contain the rationale for any
   non-obvious decision made during elicitation.
2. New L1 terms introduced in the session must be added to the L0 glossary
   before handover.
3. If a Discovery PoC `decision_outcome` influences an L3 requirement, the
   link must be explicit: the L3 PLAN `dependencies` field references the
   PoC PLAN ID.
4. Carry items must reference a PLAN ID — free-text carry without a PLAN
   anchor is invisible to `ut-tdd doctor` and will not be picked up by
   `ut-tdd status`.

## Handover validation commands

```
ut-tdd handover             # write/refresh .ut-tdd/handover/CURRENT.json
ut-tdd status               # verify active_plans matches real PLAN state
ut-tdd doctor               # confirm no orphaned FRs or broken dependencies
ut-tdd plan lint            # schema-validate PLANs listed in handover
ut-tdd review --uncommitted # review evidence gate before crossing session boundary
```

Run all five before declaring a session closed. A handover written without a
green `ut-tdd doctor` is a false-clean baton.

## Stale handover detection

`ut-tdd doctor` flags CURRENT.json as stale when:

- Its `timestamp` is older than the most recent commit that touched a PLAN
  listed in `active_plans`.
- A carry item references a PLAN whose `status` is `done` (closed carry not
  cleaned up).
- `active_plans` contains a PLAN ID that no longer exists in `docs/plans/`.

When a stale handover is detected, re-run `ut-tdd handover` after verifying
each carry item against `ut-tdd status` and `git log`. Do not extend a stale
CURRENT.json; overwrite it after verification.

## Anti-patterns

- Copying carry items forward from the previous handover without re-verifying
  against `ut-tdd status` and `git log` — causes ghost carry items that
  persist for multiple sessions after the work is done.
- Writing handover prose in a commit message or chat — invisible to
  `ut-tdd doctor` and lost at session boundary.
- Passing an L3 PLAN to a successor without resolving `clarification_pending`
  FRs — the ambiguity surfaces as a design gap at L5/L6 and is expensive to
  trace back.
- Treating `.ut-tdd/handover/CURRENT.json` as a live dashboard — it is a
  point-in-time snapshot; always run `ut-tdd status` alongside it.
