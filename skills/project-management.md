---
schema_version: skill.v1
name: project-management
skill_type: process
applies_to:
  layers:
    - L1
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
    - Reverse
    - Recovery
    - Incident
---

# project management

Cross-PLAN program/portfolio view for UT-TDD (FR-L1-01 PLAN-as-orchestration).
This skill governs the multi-PLAN perspective: milestone health, inter-PLAN
dependency sequencing, stall detection, and handover discipline at program
boundaries.

DISTINCT from `planning-and-task-breakdown`, which handles authoring the
internal anatomy of a single PLAN (frontmatter fields, §工程表 steps,
WBS granularity). This skill operates one level above: which PLANs exist,
how they depend on each other, and whether the program as a whole is healthy.

## When to load this skill

- Reviewing overall program state across multiple active PLANs before a
  milestone or session handover.
- `ut-tdd doctor` or `ut-tdd status` shows stalled, orphaned, or
  dependency-blocked PLANs that span more than one layer group.
- Deciding whether to launch a new PLAN or extend an existing one (overlap
  detection).
- A session boundary is crossed and a program-level handover must be written.
- A Recovery or Incident drive requires enumerating which PLANs are
  affected and in what sequence they should be unblocked.

## Program health commands

```
ut-tdd status               # active/stalled/draft PLANs across all layers
ut-tdd doctor               # governance violations across the full program
ut-tdd graph                # dependency graph — spot cycles and orphans
ut-tdd plan lint            # per-PLAN schema and dependency existence
ut-tdd handover             # generate .ut-tdd/handover/CURRENT.json
ut-tdd metrics              # aggregate progress signals (layer coverage, etc.)
```

Run `ut-tdd status` and `ut-tdd graph` together at the start of a program
review. A PLAN that has been `active` for more than one sprint without a
`trace-freeze` advancement is a stall signal.

## Per-requirement PLAN discipline

One PLAN per FR that requires a design artifact. This is the foundational
rule (FR-L1-01):

- Lumping multiple FRs into one PLAN is a `ut-tdd plan lint` violation.
- A PLAN without a corresponding FR in the requirement registry is an orphan
  that `ut-tdd doctor` will surface.
- When a new FR is elicited mid-program, a PLAN must be created before
  implementation begins — retroactive PLANs are Reverse back-fills, not
  Forward work.

## Dependency sequencing at program level

`ut-tdd graph` renders the full PLAN dependency graph. Before scheduling
parallel work across agents:

1. Identify the critical path (longest chain of `直列` dependencies).
2. Mark PLANs that are `並列`-safe (no shared design doc writes, no
   overlapping `generates` targets).
3. Record the parallel/serial grouping in the program milestone note in
   `.ut-tdd/handover/` — do not rely on memory alone.

Cycles in `ut-tdd graph` are hard blocks: a PLAN that directly or
transitively depends on itself cannot advance; resolve by extracting the
shared dependency into a new upstream PLAN.

## Milestone handover discipline

At each program milestone (layer group Forward freeze, Sprint boundary,
Recovery closure, Incident post-mortem):

1. Run `ut-tdd status` — confirm no active PLAN is stalled.
2. Run `ut-tdd doctor` — exit 0 required before milestone is declared.
3. Run `ut-tdd handover` — write `.ut-tdd/handover/CURRENT.json` with the
   program state snapshot.
4. Populate the handover `carry` field only with items verified against
   actual PLAN status and `git log` — never copy forward a carry item that
   is already `done` in the PLAN registry.
5. Archive the prior `CURRENT.json` to `.ut-tdd/handover/archive/` before
   overwriting.

A milestone with no recorded handover is not closed.

## PLAN overlap detection

Before creating a new PLAN, run:

```
ut-tdd status               # check for existing PLANs at the same layer/FR
ut-tdd plan lint            # will flag duplicate plan_id
ut-tdd graph                # shows if the proposed dependency already exists
```

If a candidate PLAN would duplicate more than 50% of an existing PLAN's
`generates` artifacts, extend the existing PLAN rather than creating a new
one.

## Drive-model program patterns

| Drive | Program-level concern |
|-------|-----------------------|
| Forward | One PLAN per FR; strict layer-descending order |
| Add-feature | New PLAN requires Reverse back-fill PLAN in `dependencies` |
| Recovery | Enumerate affected PLANs first; sequence unblock in `troubleshoot` PLAN |
| Incident | Time-boxed; `status: active` PLANs frozen until incident PLAN is `done` |
| Discovery | PoC PLANs time-boxed to S0-S4; `decision_outcome` required at S4 |
| Scrum | Sprint boundary = milestone handover; carry items reviewed against code |

## Anti-patterns

- Using `ut-tdd handover` output as a substitute for reading PLAN status —
  handover is a snapshot, not a live view; verify against `ut-tdd status`.
- Advancing a PLAN to `done` without all its child PLANs also `done` —
  false-green at program level.
- Creating a PLAN for convenience (grouping work) rather than for a specific
  FR — inflates program scope and breaks per-requirement traceability.
- Scheduling all steps as `[並列]` to maximize speed — gates (pair-freeze,
  trace-freeze, accept) are always `[直列]`; omitting them hides drift.
