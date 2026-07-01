---
schema_version: skill.v1
name: agent-cost-design
skill_type: orchestration
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Discovery
---

# agent cost design

When and how to delegate to lightweight subagent roles and design agent
orchestration so expensive model capacity is used only where it is needed
(FR-L1-37 model/effort recommendation, FR-L1-38 model evaluation, harness pillar
5: split work across roles/runtimes only where it reduces risk or cost).

## When to load this skill

- A research or summarisation subtask would consume large context on the primary
  model.
- You are about to call `ut-tdd claude --role <role>` and need to structure the
  delegation.
- A Discovery / Scrum cycle has a broad exploration phase that splits into
  parallel sub-tasks.

## Model tier assignment

| Task type | Assign to |
|---|---|
| Multi-source web research, doc summarisation | `pmo-haiku` |
| Hypothesis generation from collected facts | `pmo-haiku` |
| ADR authoring, gate review, design judgement | primary session model |
| Security / adversarial review | primary model or `security-audit` / `code-reviewer` |
| Routine status / handover formatting | `pmo-haiku` |

Delegation is justified when the subtask is parallelisable, needs no
repository-state judgement, and the cost saving outweighs the verification
overhead. Always pass `model` explicitly when spawning a subagent — an omitted
model inherits the expensive parent model and burns budget.

## Delegation via ut-tdd

```
ut-tdd claude --role pmo-haiku --task "..."            # execute
ut-tdd claude --role pmo-haiku --task "..." --dry-run  # inspect the prompt first
```

Route subagent calls through `ut-tdd claude` / `ut-tdd codex` / `ut-tdd team
run` rather than a raw provider spawn — only the wrappers capture session
lifecycle, handover warnings, and cost telemetry.

## Delegation prompt structure

Include: (1) objective — the decision it informs; (2) scope constraints; (3)
required output format; (4) a source-count floor for research (see the `research`
skill); (5) a reasoning-chain requirement (observed facts → interpretation →
hypothesis → verification method), not a bare summary.

## Verify delegated output

Delegated agent output is a claim, not evidence. Before recording it as
authoritative: spot-check at least one cited source yourself; confirm the
reasoning chain is present; and escalate to a full review gate if the output
would change an existing PLAN dependency or ADR decision. Re-compute any counts
the agent reports rather than trusting its narration.

## Cost evidence

Token/cost telemetry is exposed by `ut-tdd telemetry` and projected into
`model_runs` (FR-L1-38). When adding an agent call path, record run metadata
(runtime, model, role, drive, plan_id, timings) — metadata only, never prompt or
response text, credentials, or PII. If a call escapes the wrapper, record a
manual `.ut-tdd/audit/` entry so the cost obligation is not silently dropped.

## Anti-patterns

- Delegating repository-state judgement ("is this PLAN complete?") to a
  lightweight role — it cannot reliably read `.ut-tdd/` state.
- Sequential delegations where one well-structured parallel split is cheaper.
- Forwarding raw delegated output to the PO without a spot-check.
