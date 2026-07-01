---
schema_version: skill.v1
name: context-engineering
skill_type: orchestration
applies_to:
  layers:
    - L1
    - L3
    - L6
    - L7
    - L8
    - L9
    - L10
    - L11
    - L12
    - L13
  drive_models:
    - Forward
    - Discovery
    - Scrum
    - Reverse
    - Recovery
    - Add-feature
---

# context engineering

What to inject into each V-model layer invocation, how to stay within context
budget, and when to use dynamic skill loading instead of pre-loading everything
(FR-L1-12 per-layer context/skill injection, harness pillar 4 dynamic context /
skill injection).

## When to load this skill

- Designing which docs to include in a subagent or team-run prompt.
- A subagent prompt is overflowing context budget (~200 KB practical ceiling for
  Sonnet-class models).
- Adding a new V-model layer to the harness that needs a context injection rule.
- A `ut-tdd skill suggest --plan <path>` output is being acted on.

## Per-layer injection table

Load only the layers actually required for the current task. Do not pre-load the
full doc tree.

| Layer group | Canonical inject | Dynamic add |
|---|---|---|
| L0–L3 (concept/requirement) | `CLAUDE.md`, `docs/governance/README.md`, concept + requirements docs | Relevant ADRs, L0 glossary |
| L4–L6 (design) | L3 requirements for the feature, PLAN doc, design doc skeleton | `documentation-and-adrs` skill, parent design doc |
| L7 (implementation) | PLAN doc, L6 function-spec, `src/` target files | `gate-planning` skill, test file |
| L8–L10 (integration / system test) | PLAN, test-design doc, `tests/` target | `harness-observability` skill |
| L11–L14 (acceptance / production) | PLAN, acceptance criteria, `ut-tdd doctor` output | ADR list, handover state |

Use `ut-tdd skill suggest --plan <path>` to get a computed skill recommendation
for a specific PLAN before composing a subagent prompt.

## Context budget rules

- Primary session context ceiling (practical): ~150–200 KB. Reserve ~30 KB for
  the response.
- Each additional doc loaded costs the full file size. Prefer targeted `Read`
  over bulk directory loads.
- Skills are ~2–4 KB each; load the 1–3 most relevant, not the full catalog.
- `CLAUDE.md` + `.claude/CLAUDE.md` together cost ~10 KB. Always included;
  do not duplicate their content in the prompt.
- Large governance docs (concept, requirements) cost ~15–20 KB each. Load only
  when the task requires design-authority context.

## Dynamic loading procedure

1. Run `ut-tdd skill suggest --plan <path>` to get the recommended skill set.
2. Load the top 1–3 skills. If the task spans multiple layers, load the skill
   for the highest-risk layer first.
3. For subagent prompts: include only the docs the subagent needs to complete
   its specific subtask. Do not forward the full primary session context.
4. After loading, confirm total injected size stays within budget before
   spawning.

## What not to inject

- Migration snapshots (`docs/archive/`, `vendor source snapshot`) — historical
  only; never needed for forward work.
- The full `docs/plans/` directory — pass the single relevant PLAN file.
- Session logs or raw `harness.db` dumps — use `ut-tdd metrics` / `ut-tdd find`
  queries instead.
- Credentials, API keys, PII — never in prompt context. See safety boundaries in
  `CLAUDE.md`.

## Skill injection vs static load

Static loads (files listed in `CLAUDE.md` read order) are paid every session
regardless of task. Dynamic loads are triggered by the task at runtime. When a
skill applies to fewer than half of typical sessions, keep it out of the static
read order and load dynamically via `ut-tdd skill suggest` or explicit `Read`.
