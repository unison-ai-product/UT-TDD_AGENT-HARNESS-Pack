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
decision_points:
  - when: "Scoring Uncertainty for a Reverse or Retrofit Issue"
    choose: "read the existing source first and score Uncertainty at 2 or 3 by default"
    over: "assigning Uncertainty=1 because the change looks small before reading the code"
    because: "existing code without design coverage is typically 2 or 3; scoring 1 without reading understates the actual unknowns in undocumented code"
  - when: "An Issue's three-axis sum lands at 5 or higher"
    choose: "split or timebox the Issue and annotate the §工程表 with the session-split point and expected handover artifact path"
    over: "scheduling it as a single uninterrupted session because the team is confident"
    because: "a session that crosses a natural gate without a handover record is an untracked session split — the score threshold exists specifically to force that annotation"
  - when: "One axis (Size, Dependency depth, or Uncertainty) scores 3 but the total sum is only 4-5"
    choose: "trigger decomposition review based on the single 3-score axis"
    over: "using the sum alone to decide the Issue fits one session"
    because: "a single axis at 3 signals a specific risk (cross-layer scope, unresolved dep chain, or novel/PoC-required work) that averaging into a lower sum would hide"
  - when: "Delegating an Issue scored 7+ to a sub-agent"
    choose: "split it into child Issues before delegating"
    over: "delegating the 7+ Issue as-is and trusting the agent to manage scope"
    because: "a 7+ Issue handed to a delegate invites runaway scope expansion with no natural checkpoint"
  - when: "A \"small fix\" Issue is being authored"
    choose: "run the three-axis scoring anyway and record it in the Issue body"
    over: "skipping sizing because the fix looks trivial"
    because: "unscored Issues accumulate into stalled sessions — the skip itself is the failure mode, not any single small fix"
---

# estimation

Complexity and effort scoring for UT-TDD Issues before schedule commitment
(FR-L1-39 task complexity / effort). `ut-tdd task classify --text "..."` is
implemented and auto-scores `size` / `complexity_score` / `difficulty` /
`risk_flags` — run it first and record its output in the Issue body; author
judgment adjusts the result rather than replacing it with manual scoring.

## When to load this skill

- Authoring an Issue that will be delegated to an agent and must fit a
  session boundary.
- A Discovery S1 plan step needs relative sizing before S2 PoC begins.
- A sprint has stalled and the root cause is under-estimated scope.
- Multiple Issues are competing for the same session slot and must be
  prioritised.

## Scoring dimensions

Score each Issue on three axes before writing the §工程表:

| Axis | 1 (small) | 2 (medium) | 3 (large) |
|---|---|---|---|
| **Size** | single doc or single src file | 2-5 files, one layer | cross-layer, >5 files |
| **Dependency depth** | no unresolved dependencies | 1-2 resolved deps | chain of 3+ or unresolved dep |
| **Uncertainty** | well-understood pattern | some unknowns, research needed | novel, requires PoC first |

Record the three scores and their sum in the Issue body (e.g., `[2+1+2=5]`).
Total 3-4: fits one session. Total 5-6: split or timebox. Total 7-9: must
decompose into child Issues before scheduling.

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
scheduling an Issue that scores 5+, annotate the §工程表 with which step
ends the first session and write the expected handover artifact path
(`.ut-tdd/handover/CURRENT.json`).

## Delegation sizing

When delegating to a sub-agent:

- Pass the Issue link, relevant design revision, and task description.
- An Issue sized 7+ must be split into child Issues first; delegating a
  7+ Issue invites runaway scope expansion.

## Check prerequisites after sizing

```
gh issue list --state open   # review active and stalled work
ut-tdd doctor               # governance gate — unresolved deps surface here
```

## Anti-patterns

- Assigning Uncertainty=1 to a Reverse or Retrofit Issue without reading
  the existing source first.
- Skipping sizing entirely for "small fixes" — unscored Issues accumulate
  into stalled sessions.
- Using the sum score alone to skip decomposition when one axis scores 3;
  a single axis at 3 warrants decomposition review regardless of total.
