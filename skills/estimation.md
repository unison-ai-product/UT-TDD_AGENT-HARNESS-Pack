---
schema_version: skill.v1
name: estimation
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
    - Refactor
    - Retrofit
---

# estimation

Complexity and effort scoring for UT-TDD PLANs before schedule commitment
(FR-L1-39 task complexity / effort). There is no `ut-tdd task classify` or
`ut-tdd task estimate` CLI yet; scoring is done by the author at PLAN
authoring time and recorded in the PLAN body.

## When to load this skill

- Authoring a PLAN that will be delegated to an agent and must fit a
  session boundary.
- A Discovery S1 plan step needs relative sizing before S2 PoC begins.
- A sprint has stalled and the root cause is under-estimated scope.
- Multiple PLANs are competing for the same session slot and must be
  prioritised.

## Scoring dimensions

Score each PLAN on three axes before writing the §工程表:

| Axis | 1 (small) | 2 (medium) | 3 (large) |
|---|---|---|---|
| **Size** | single doc or single src file | 2-5 files, one layer | cross-layer, >5 files |
| **Dependency depth** | no unresolved dependencies | 1-2 resolved deps | chain of 3+ or unresolved dep |
| **Uncertainty** | well-understood pattern | some unknowns, research needed | novel, requires PoC first |

Record the three scores and their sum in the PLAN body (e.g., `[2+1+2=5]`).
Total 3-4: fits one session. Total 5-6: split or timebox. Total 7-9: must
decompose into child PLANs before scheduling.

## Drive-model adjustments

- **Forward / Add-feature:** Reverse back-fill adds +1 to Size if the
  generated design doc is new; note it explicitly.
- **Reverse / Retrofit:** Uncertainty is rarely 1 — existing code without
  design coverage is typically 2 or 3.
- **Refactor:** Dependency depth rises when the refactored module is
  imported by many callers; count unique import sites.
- **Discovery (Scrum):** Score the S2 PoC step alone; S3 verify and
  S4 decide are not sized until S2 completes.
- **Recovery / Incident:** Time-box to a single session regardless of
  score; record scope-reduction decisions in `.ut-tdd/audit/`.

## Session-boundary rules

An agent session that crosses a natural gate (pair-freeze, trace-freeze,
accept) without a handover record is an untracked session split. Before
scheduling a PLAN that scores 5+, annotate the §工程表 with which step
ends the first session and write the expected handover artifact path
(`.ut-tdd/handover/CURRENT.json`).

## Delegation sizing

When delegating to a sub-agent:

- Pass the PLAN path, not a free-form task description.
- Confirm `ut-tdd plan lint` exits 0 on the PLAN before delegation.
- A PLAN sized 7+ must be split into child PLANs first; delegating a
  7+ PLAN invites runaway scope expansion.

## Validation after sizing

```
ut-tdd plan lint            # rejects schema violations, catches missing deps
ut-tdd status               # shows which PLANs are active vs stalled
ut-tdd doctor               # governance gate — unresolved deps surface here
```

## Anti-patterns

- Assigning Uncertainty=1 to a Reverse or Retrofit PLAN without reading
  the existing source first.
- Skipping sizing entirely for "small fixes" — unscored PLANs accumulate
  into stalled sessions.
- Using the sum score alone to skip decomposition when one axis scores 3;
  a single axis at 3 warrants decomposition review regardless of total.
