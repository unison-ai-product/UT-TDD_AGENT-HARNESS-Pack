---
schema_version: skill.v1
name: agent-teams
skill_type: orchestration
applies_to:
  layers:
    - L1
    - L3
    - L5
    - L6
    - L7
    - L8
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Reverse
    - Recovery
---

# agent teams

How to structure multi-agent team runs in UT-TDD: role separation between
frontier reviewer, worker, and fast checker; no-self-approval enforcement; and
team YAML authoring (FR-L1-12 team run, harness pillar 5 split work across
roles/runtimes only where it reduces risk or cost).

## When to load this skill

- Authoring or editing a `.ut-tdd/teams/<team>.yaml` team definition.
- A judgement gate requires cross-runtime or cross-model-family review evidence.
- A Discovery or Add-feature PLAN needs parallel worker + reviewer separation.
- A Recovery incident needs a dedicated fast-checker role to verify fixes.

## Team YAML structure

Teams run via:

```
ut-tdd team run --definition .ut-tdd/teams/<team>.yaml
```

A team definition declares:

| Field | Purpose |
|---|---|
| `name` | Team identifier |
| `roles` | Ordered list of role entries (name, agent, model, task) |
| `mode` | `parallel` or `serial` |
| `judgement_gate` | Which role produces the binding verdict |

Each `agent` value must be an allowlisted `subagent_type`; each `model` must
match that agent's frontmatter family. The team runner does not relax the guard.

## Role separation rules

**No self-approval.** The agent that produces an artefact must not also be the
agent that clears the judgement gate. Enforce this by assigning different model
families to worker and reviewer slots:

| Slot | Example assignment | Rule |
|---|---|---|
| Worker / implementer | `pmo-haiku` | Produces artefact |
| Reviewer / frontier | `code-reviewer` (primary model) | Clears gate — different family |
| Fast checker | `pmo-project-scout` | Structural checks only, not final verdict |

In single-runtime mode (no second model family available), the reviewer slot
must record `intra_runtime_subagent` evidence in `.ut-tdd/audit/` rather than
passing the gate silently.

## Judgement gate behaviour

`ut-tdd gate <id>` reads execution mode from `ut-tdd status`. In hybrid mode a
cross-family reviewer verdict is required. In single-runtime mode an
`intra_runtime_subagent` record is the minimum — document the limitation and
escalate if the risk is high.

## Parallel vs serial mode

Use `parallel` when worker slots produce independent artefacts with no ordering
dependency. Use `serial` when a later step requires the verified output of an
earlier one (e.g., research → judgement → ADR authoring). Mixing modes in a
single team definition is not supported; split into two team runs instead.

## Team design checklist

- [ ] Each `agent` value is in the guard allowlist.
- [ ] Each `model` is explicit and matches the agent's frontmatter family.
- [ ] Worker and judgement-gate slots use different model families (or
      `intra_runtime_subagent` evidence is planned).
- [ ] `mode` is explicitly `parallel` or `serial`.
- [ ] `ut-tdd team run --definition <path>` tested with `--dry-run` equivalent
      before first live execution.
- [ ] Post-run: verify artefacts by reading files + `git status`, not by
      trusting agent narration.

## Anti-patterns

- Assigning the same agent role to both worker and judgement-gate — the guard
  does not enforce this; the team author must.
- Using `parallel` mode when step 2 depends on step 1 output — produces
  non-deterministic results.
- Omitting `model` in a role entry — the guard rejects the spawn at runtime.
