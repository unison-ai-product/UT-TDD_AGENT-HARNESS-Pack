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
  - when: "a subagent is needed for a role that has no harness definition"
    choose: "use a generic subagent_type (general-purpose / Explore / Plan / claude) with an explicit, recognised, non-fable model, and keep closing review on the ut-tdd claude|codex --role path"
    over: "adding a new .claude/agents definition or a new allowlist entry"
    because: "#1002 retired the hand-written definitions; the generic route passes with an explicit model and has no closing authority"
  - when: "choosing the model for a generic subagent"
    choose: "set model explicitly, even if it would match the parent"
    over: "omitting model and relying on inheritance"
    because: "the guard blocks omitted model - it does NOT silently inherit the parent, so an omission is a hard failure, not a convenience"
  - when: "the guard rejects an Agent call and the cause is unclear"
    choose: "check, in order, subagent_type is one of the four generic types (exact, case-sensitive), model presence, model normalization (recognised family), and not fable"
    over: "reaching for UT_TDD_ALLOW_RAW_AGENT=1 as the first fix"
    because: "bypass is for a diagnosed emergency only, not a default troubleshooting step"
  - when: "UT_TDD_ALLOW_RAW_AGENT=1 is used to unblock a spawn"
    choose: "write an audit entry to .ut-tdd/audit/ recording who, which call, and why"
    over: "using the bypass silently and moving on once the call succeeds"
    because: "bypass without audit evidence leaves the emergency undocumented and unreviewable"
---

# agent design

How to spawn a subagent through the Agent tool in UT-TDD. The harness keeps no
subagent definition files (#1002): expertise is passed per task as skills, decision
packs, and design excerpts, not by subagent name. Apply when a PreToolUse(Agent)
guard rejection must be diagnosed, or when a task needs parallel work inside a lane.

## When to load this skill

- A `PreToolUse(Agent)` guard rejection requires diagnosing which rule failed.
- A Discovery or Add-feature PLAN needs a specialist role (use a generic type and
  pass the specialty in the task text; do not add a definition).

## Generic route

The guard allows only `GENERIC_SUBAGENT_TYPES` (`src/runtime/agent-guard-policy.ts`;
the list is not copied here - it drifts): `general-purpose`, `Explore`, `Plan`, `claude`.
Matching is exact. The call must carry an explicit, recognised model; `fable` is not
allowed in the Agent tool. The guard has no model floor. A subagent has no closing
authority: its output is a draft or investigation material, never a verdict. Closing
review goes through `ut-tdd claude|codex --role <role>` and review custody.

## Guard bypass

`UT_TDD_ALLOW_RAW_AGENT=1` bypasses the type, model, and fable checks (not the
missing-tool_name check). Use only in a diagnosed emergency. Bypassing must leave an
audit entry in `.ut-tdd/audit/` recording: who set the flag, which agent call was
made, and why the normal path was unsuitable.

## Self-review checklist

- [ ] `subagent_type` is one of the four generic types, spelled exactly.
- [ ] `model` is explicit, recognised, and not fable.
- [ ] No new definition or allowlist entry is added (#1002); specialty goes in the task.
- [ ] Anything that closes a review or gate goes through `ut-tdd claude|codex --role`.
- [ ] Bypass evidence written to `.ut-tdd/audit/` when `UT_TDD_ALLOW_RAW_AGENT=1`
      was set.
