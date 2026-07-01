---
schema_version: skill.v1
name: planning-and-task-breakdown
skill_type: orchestration
applies_to:
  layers:
    - L1
    - L3
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Scrum
    - Discovery
---

# planning and task breakdown

How to decompose a feature or requirement into a PLAN hierarchy and
schedule steps that can be delegated to agents or executed deterministically
(FR-L1-01 PLAN management, FR-L1-13 Forward workflow).

## When to load this skill

- Authoring a new PLAN file in `docs/plans/`.
- Splitting a large requirement into child PLANs or schedule steps.
- A `ut-tdd doctor` failure reports an orphaned PLAN or a missing
  `generates` link.
- A §工程表 schedule section needs parallel/serial annotation.

## Decomposition target: unit-test-design granularity

The correct stopping point for breakdown is one design document paired
with one test-design document — a V-model pair at L6/L7. A step that
cannot be verified at unit-test-design granularity is too large; split it.

Child PLANs are created when a step produces its own design doc (its own
`generates` artifact). Steps that do not produce a standalone doc remain
schedule steps within the parent PLAN.

## PLAN frontmatter checklist

Before running `ut-tdd plan lint`, confirm every field:

- [ ] `plan_id` is unique and matches the filename (`PLAN-<kind>-<NN>`).
- [ ] `kind` is one of: `design`, `impl`, `add-design`, `add-impl`, `poc`,
  `reverse`, `recovery`, `refactor`, `retrofit`, `research`, `troubleshoot`.
- [ ] `layer` is the V-model layer the PLAN primarily targets.
- [ ] `drive` declares the drive model (Forward, Add-feature, Reverse, etc.).
- [ ] `status` is one of: `draft`, `active`, `pair-freeze`, `trace-freeze`,
  `done`, `cancelled`.
- [ ] `generates` lists every design/test-design doc this PLAN produces.
- [ ] `dependencies` lists every upstream PLAN or doc this PLAN requires;
  each referenced ID must resolve or `ut-tdd plan lint` will flag it.
- [ ] `review_evidence` is populated before advancing to `trace-freeze`.

## Authoring §工程表 (schedule steps)

Schedule steps are numbered and annotated with execution mode:

```
## §工程表
1. [並列] Author L5 detailed design doc — PLAN-L5-NN
2. [並列] Author L6 unit-test design doc — PLAN-L6-NN
3. [直列] pair-freeze review: ut-tdd review --uncommitted
4. [直列] implement src/ — PLAN-L7-NN
5. [直列] trace-freeze: bun run test && ut-tdd doctor
6. [直列] accept: ut-tdd review --uncommitted (no blocking findings)
```

`[並列]` steps may run concurrently across agents. `[直列]` steps must
complete in order; each is a gate. A schedule with no serial gate steps
around pair-freeze and trace-freeze is a decomposition error.

## WBS rules

- One PLAN per FR (requirement) that needs a design doc. Lumping multiple
  FRs into one PLAN is a lint violation.
- Add-feature kind requires a Reverse back-fill pairing declared in the
  `dependencies` field.
- A `poc` PLAN follows Discovery phases (S0-S4); its §工程表 maps to
  S2(poc) and S3(verify) steps explicitly.

## Validation commands

```
ut-tdd plan lint            # schema + schedule + dependency existence
ut-tdd doctor               # all harness governance gates
ut-tdd graph                # visualise PLAN dependency graph
ut-tdd status               # surface active/stalled PLANs
```

## Anti-patterns

- Steps labelled "implement everything" with no layer annotation — too
  coarse; one step per V-model layer transition.
- `generates` left empty on a `design` or `add-design` kind — the doc
  produced by this PLAN is then invisible to `ut-tdd doctor`.
- Marking `status: done` without a populated `review_evidence` field —
  false-green that later doctor runs will surface.
