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
decision_points:
  - when: "defining a new .claude/agents/<name>.md and choosing whether model can be left blank"
    choose: "set model explicitly, even if it would match the parent"
    over: "omitting model and relying on inheritance"
    because: "the guard blocks omitted model — it does NOT silently inherit the parent, so an omission is a hard failure, not a convenience"
  - when: "a subagent_type is needed but does not appear in the current guard allowlist"
    choose: "update agent-guard.ts allowlist and document the capability class before using it"
    over: "invoking the role anyway or approximating with a similar allowlisted name"
    because: "any role outside the list is blocked fail-close; there is no fuzzy match"
  - when: "assigning a model tier to a new agent's capability class"
    choose: "assign the minimum capable tier for that class (e.g., fast/cheap for research, primary-equivalent for adversarial review)"
    over: "defaulting every new agent to the primary model for safety"
    because: "the taxonomy exists precisely to avoid over-provisioning cost to roles that don't need primary-tier judgement"
  - when: "the guard rejects an Agent call and the cause is unclear"
    choose: "check subagent_type match, model presence, and allowlist membership in that order before assuming a bug"
    over: "reaching for UT_TDD_ALLOW_RAW_AGENT=1 as the first fix"
    because: "bypass is for a diagnosed emergency only, not a default troubleshooting step"
  - when: "UT_TDD_ALLOW_RAW_AGENT=1 is used to unblock a spawn"
    choose: "write an audit entry to .ut-tdd/audit/ recording who, which call, and why"
    over: "using the bypass silently and moving on once the call succeeds"
    because: "bypass without audit evidence leaves the emergency undocumented and unreviewable"
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
