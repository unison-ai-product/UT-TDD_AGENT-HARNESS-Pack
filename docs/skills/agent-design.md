---
schema_version: skill.v1
name: agent-design
skill_type: design-contract
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Refactor
---

# agent design

How to define a single subagent in UT-TDD: capability class, model-family
assignment, and guard-allowlist registration (FR-L1-46 subagent roster). Apply
when introducing a new agent role, changing a model family, or auditing whether
an existing agent definition matches its actual use.

## When to load this skill

- Authoring or editing a `.claude/agents/<name>.md` frontmatter definition.
- A `PreToolUse(Agent)` guard rejection requires diagnosing which rule failed.
- A Discovery or Add-feature PLAN needs a new specialist role not yet in the
  allowlist.
- Refactoring an existing agent definition to correct a model-family mismatch.

## Anatomy of a subagent definition

Every `.claude/agents/<name>.md` must carry:

| Field | Purpose | Enforcement |
|---|---|---|
| `name` (frontmatter) | Must match the kebab filename | `agent-guard.ts` key lookup |
| `model` | Explicit model string (no omission) | Guard blocks omitted model — parent is NOT inherited |
| `description` | One-line capability summary | Used by `ut-tdd skill suggest` |
| `tools` | Declared tool list | Guard validates against allowed surfaces |

The `subagent_type` in the Agent call must match one of the guard allowlist
entries exactly (case-sensitive). Current allowlist:

```
pmo-sonnet  pmo-haiku  pmo-project-explorer  pmo-project-scout
pmo-tech-docs  pmo-tech-fork  pmo-tech-news
pdm-tech-innovation  pdm-marketing-innovation  pdm-innovation-manager
code-reviewer  security-audit  qa-test
```

Any role outside this list is blocked fail-close. To add a role, update
`agent-guard.ts` allowlist and document the capability class here.

## Capability class taxonomy

| Class | Typical roles | Right model tier |
|---|---|---|
| Research / summarisation | `pmo-haiku`, `pmo-tech-news` | Fast / cheap |
| Repo-state judgement | `pmo-project-explorer`, `pmo-sonnet` | Mid-tier |
| Design review / adversarial | `code-reviewer`, `security-audit` | Primary / equivalent |
| QA / trace verification | `qa-test` | Mid-tier |
| Innovation / market analysis | `pdm-*` | Mid-tier |

Assign the minimum capable tier. An omitted `model` field causes the guard to
reject the spawn — it does not silently inherit the parent.

## Guard bypass

`UT_TDD_ALLOW_RAW_AGENT=1` bypasses the guard. Use only in a diagnosed
emergency. Bypassing must leave an audit entry in `.ut-tdd/audit/` recording:
who set the flag, which agent call was made, and why the normal path was
unsuitable.

## Self-review checklist

- [ ] `name` in frontmatter matches the filename (kebab-case, no spaces).
- [ ] `model` field is explicit — no blank, no placeholder.
- [ ] `subagent_type` in the spawn call matches an allowlist entry exactly.
- [ ] Capability class justified: the chosen model tier is the minimum needed.
- [ ] If the role is new: allowlist in `agent-guard.ts` updated and tested.
- [ ] Bypass evidence written to `.ut-tdd/audit/` when `UT_TDD_ALLOW_RAW_AGENT=1`
      was set.
