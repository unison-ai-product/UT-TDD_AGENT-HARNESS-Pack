---
schema_version: skill.v1
name: poc
skill_type: verification
applies_to:
  layers:
    - L1
    - L2
  drive_models:
    - Discovery
    - Scrum
    - Forward
---

# poc

How to run a time-boxed Proof of Concept inside UT-TDD (FR-L1-15 Discovery
S0-S4 hypothesis-to-decide loop, FR-L1-43 PoC success criteria and
`decision_outcome` recording). A PoC is a machine-recorded investigation
cycle, not informal spiking — the decision outcome must land in PLAN state
and `.ut-tdd/` before work proceeds to Forward implementation.

## When to load this skill

- A Discovery cycle has reached S2 (poc) and code or integration tests are
  needed to answer the hypothesis.
- A PLAN with `kind: poc` is being authored or advanced.
- A Scrum S3 verify step requires experimental evidence before S4 decide.
- `ut-tdd doctor` flags a `poc` PLAN with no `decision_outcome` field.

## Discovery phase mapping (S0-S4)

| Phase | UT-TDD action |
|-------|--------------|
| S0 backlog | FR elicited; PLAN `kind: poc` authored with `hypothesis` field; `status: draft` |
| S1 plan | Acceptance criteria written in PLAN `poc_criteria` field; time-box set; `ut-tdd plan lint` exits 0 |
| S2 poc | Spike code or integration test authored in `tests/poc/` or a tagged branch; evidence collected |
| S3 verify | PoC evidence reviewed against `poc_criteria`; `ut-tdd review --uncommitted` for the PLAN |
| S4 decide | `decision_outcome` set to `adopt`, `reject`, or `defer`; PLAN advanced to `done` or `cancelled`; handover written |

The PLAN `status` field tracks phase: `draft` (S0-S1) -> `active` (S2) ->
`trace-freeze` (S3) -> `done`/`cancelled` (S4).

## PLAN frontmatter for a PoC

```yaml
kind: poc
layer: L2
drive: Discovery
status: active
hypothesis: "Can Vitest handle 500 harness-db projections in under 2 s?"
poc_criteria:
  - "bun run test completes under 2000 ms on CI hardware"
  - "No memory leak observed in 3 consecutive runs"
decision_outcome: ""   # filled at S4
generates:
  - docs/design/poc/L2-poc-projection-perf.md
review_evidence: []
```

`ut-tdd plan lint` will reject a `poc` PLAN that is in `done` status with
an empty `decision_outcome`.

## §工程表 for a Discovery PoC

```
## §工程表
1. [直列] Author PLAN frontmatter + hypothesis (S0-S1)
2. [直列] ut-tdd plan lint — schema and poc_criteria present
3. [並列] Implement spike in tests/poc/ or scoped branch (S2)
4. [並列] Collect evidence: timing, logs, error rates
5. [直列] ut-tdd review --uncommitted — findings against poc_criteria (S3)
6. [直列] Set decision_outcome; update PLAN status; ut-tdd doctor (S4)
7. [直列] ut-tdd handover — record outcome for next session/agent
```

## Decision outcomes

- **adopt**: hypothesis confirmed; create a Forward `add-impl` PLAN to
  productionise; link the PoC PLAN in the new PLAN's `dependencies`.
- **reject**: hypothesis falsified; PLAN `status: cancelled`; document why in
  `review_evidence` so the same spike is not repeated.
- **defer**: inconclusive; record blocker in `review_evidence`; set a TTL in
  the handover; return to S1 when the blocker is resolved.

Spike code in `tests/poc/` is not merged to `src/` until an `adopt` decision
produces a proper `add-impl` PLAN with a Reverse back-fill pairing.

## Validation commands

```
ut-tdd plan lint            # poc_criteria and decision_outcome checks
ut-tdd doctor               # flags poc PLANs in done with empty outcome
ut-tdd review --uncommitted # S3 gate evidence
ut-tdd handover             # S4 baton to next session
ut-tdd status               # surface stalled Discovery PLANs
```

## Anti-patterns

- Promoting spike code directly into `src/` without an `adopt` decision and
  a follow-on `add-impl` PLAN — bypasses V-model descent and Reverse back-fill.
- Leaving `decision_outcome` empty after `status: done` — false-green that
  `ut-tdd doctor` will surface.
- Writing PoC results only in chat or commit messages — evidence must be in
  `review_evidence` or `.ut-tdd/audit/` to survive session boundaries.
- Time-boxing the spike but not the decision phase — a PoC without an S4
  decide date accumulates as indefinite `active` state.
