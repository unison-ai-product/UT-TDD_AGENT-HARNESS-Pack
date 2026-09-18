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
decision_points:
  - when: "Composing a prompt for a subagent or team-run task."
    choose: "Include only the docs the subagent needs for its specific subtask."
    over: "Forwarding the full primary session context to the subagent."
    because: "Harness pillar 4 (dynamic context/skill injection) and the context budget rules require per-task scoping; forwarding full context wastes the subagent's budget and drowns the relevant signal."
  - when: "Selecting how many skills to load for a task."
    choose: "Load the 1-3 most relevant skills, using `ut-tdd skill suggest --plan <plan-id>` to pick them."
    over: "Pre-loading the full skill catalog to be safe."
    because: "Skills cost ~2-4 KB each and the practical context ceiling is ~150-200 KB; bulk-loading crowds out budget for the actual task docs."
  - when: "A task spans multiple V-model layers and context budget is limited."
    choose: "Load the skill for the highest-risk layer first."
    over: "Loading all applicable layer skills in file-list order."
    because: "Budget is finite and risk is not evenly distributed across layers; prioritizing the highest-risk layer ensures the most consequential judgement gets the needed context even if lower layers must load dynamically later."
  - when: "A task could use migration snapshots, `docs/archive/`, or vendor source snapshots for background."
    choose: "Exclude them from injected context."
    over: "Including them for extra historical context."
    because: "The skill classifies them as historical-only material never needed for forward work; including them burns budget without informing the current task."
  - when: "A skill would only be relevant to a minority of sessions for a given layer."
    choose: "Keep it out of the static read order and load it dynamically via `ut-tdd skill suggest` or explicit `Read`."
    over: "Adding it to the static CLAUDE.md read order so it's always available."
    because: "Static loads are paid every session regardless of task; the skill's own threshold is fewer-than-half of typical sessions as the cutoff for dynamic-only loading."
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
- A `ut-tdd skill suggest --plan <plan-id>` output is being acted on.

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

Use `ut-tdd skill suggest --plan <plan-id>` to get a computed skill recommendation
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

1. Run `ut-tdd skill suggest --plan <plan-id>` to get the recommended skill set.
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
- Session logs or raw `harness.db` dumps — use `ut-tdd metrics skill` /
  `ut-tdd find <query>` instead.
- Credentials, API keys, PII — never in prompt context. See safety boundaries in
  `CLAUDE.md`.

## Skill injection vs static load

Static loads (files listed in `CLAUDE.md` read order) are paid every session
regardless of task. Dynamic loads are triggered by the task at runtime. When a
skill applies to fewer than half of typical sessions, keep it out of the static
read order and load dynamically via `ut-tdd skill suggest` or explicit `Read`.
