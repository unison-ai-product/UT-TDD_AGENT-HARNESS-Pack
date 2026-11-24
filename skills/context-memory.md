---
schema_version: skill.v1
name: context-memory
skill_type: process
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
    - Scrum
    - Reverse
    - Recovery
    - Incident
    - Refactor
    - Retrofit
decision_points:
  - when: "A session starts and `CURRENT.json` lists `carry` items from the previous session."
    choose: "Cross-check each carry item against `git log` and current file state before acting on it."
    over: "Treating the carry list as an accurate to-do list and starting work directly from it."
    because: "The skill states carry is a claim, not truth; a carry item that conflicts with git log or doctor output is stale and would misdirect the new session."
  - when: "A handover lists unfinished work."
    choose: "Verify the linked GitHub Issue and PR before acting."
    over: "Starting from the handover list alone."
    because: "The current Issue and PR can show completion or an assignment change that the handover predates."
  - when: "Work completes or a drive-model cycle boundary is crossed."
    choose: "Run `ut-tdd handover` to flush the session log and rewrite `CURRENT.json`."
    over: "Continuing directly into the next task without flushing handover state."
    because: "Skipping handover at a drive-cycle boundary means the next session starts blind, per the skill's explicit anti-pattern."
  - when: "`CURRENT.json` is older than ~24 hours or several sessions have elapsed without a handover flush."
    choose: "Treat it as potentially stale and verify open items against Git and GitHub."
    over: "Propagating the existing carry state as current."
    because: "The skill flags >24h age as a staleness threshold; state drifts across unflushed sessions faster than the handover narrative reflects."
  - when: "A session decision needs to be recorded for future continuity."
    choose: "Record it in committed docs or ADRs."
    over: "Storing the decision only in the handover file (`CURRENT.json`)."
    because: "The skill states handover is continuity glue, not the authoritative record; handover-only decisions vanish or go stale without a committed trace."
  - when: "Reporting session-close state to the PO or next session."
    choose: "Capture `ut-tdd status` and `ut-tdd doctor` output into `.ut-tdd/audit/<session-id>-close.txt` as evidence."
    over: "Relying on the handover narrative text alone as the close record."
    because: "The skill explicitly instructs not to rely on the handover narrative alone; machine command output is the verifiable evidence, not prose."
---

# context memory

How to maintain continuity across sessions using `.ut-tdd/handover/CURRENT.json`
and session log digests — and how to verify that handover carry state is actually
true (FR-L1-31 session log, FR-L1-42 handover state).

## When to load this skill

- Starting a new session where a `CURRENT.json` handover exists.
- Closing out a work item or crossing a drive-model cycle boundary.
- A task will span more than one session or runtime switch.
- A Scrum S3 verify or Recovery exit needs handover evidence before the next
  session begins.

## CURRENT.json anatomy

`ut-tdd handover` writes `.ut-tdd/handover/CURRENT.json`. The file contains:

| Field | What it records |
|---|---|
| `carry` | Items the previous session reported as incomplete |
| `completed` | Items the previous session reported as done |
| `session_digest` | Compressed event log from the closing session |

**Treat `carry` as a claim, not truth.** Before acting on it:

1. Run `git log --oneline -20` and cross-check completed work against actual
   commits.
2. Run `ut-tdd doctor` to confirm structural state.
3. Run `ut-tdd status` to confirm the runtime and check active Issues and PRs on GitHub.
4. Any carry item that conflicts with `git log` or `doctor` output is stale —
   update or remove it before proceeding.

## Session-close procedure

At the end of a work item or session:

```
ut-tdd handover
```

This flushes the session log and rewrites `CURRENT.json`. If the task crosses a
drive-cycle boundary (e.g., Add-feature trace-freeze), also run:

```
ut-tdd status
ut-tdd doctor
```

Capture both outputs into `.ut-tdd/audit/<session-id>-close.txt` as the
session-close evidence. Do not rely on the handover narrative alone.

## Session-start procedure

1. Read `.ut-tdd/handover/CURRENT.json` if it exists and is not stale
   (timestamp within ~24 hours).
2. Verify each `carry` item against `git log` and current file state — do not
   re-report items that are already committed.
3. Reconcile the listed items with current GitHub Issues and PRs.
4. Proceed with the verified carry, not the raw handover text.

## Session log and digests

The `SessionStart` and `Stop` hooks use `src/runtime/session-log.ts`. Session
logs provide metadata for the runtime summary. Use the committed head, Issue,
and PR for durable work and review evidence.

## Staleness and multi-session gaps

A `CURRENT.json` older than 24 hours should be treated as potentially stale.
Verify open items from scratch rather than propagating possibly outdated carry.
If multiple sessions have elapsed, check the repository and GitHub state before
using any carry item.

## Anti-patterns

- Forwarding raw `CURRENT.json` carry to the PO without a `git log` cross-check
  — stale carry creates false incident reports.
- Skipping `ut-tdd handover` at a drive-cycle boundary — the next session starts
  blind.
- Storing session decisions in the handover file rather than in committed docs or
  ADRs — handover is continuity glue, not the authoritative record.
