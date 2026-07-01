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
---

# context memory

How to maintain continuity across sessions using `.ut-tdd/handover/CURRENT.json`
and session log digests — and how to verify that handover carry state is actually
true (FR-L1-31 session log, FR-L1-42 handover state).

## When to load this skill

- Starting a new session where a `CURRENT.json` handover exists.
- Closing out a PLAN or crossing a drive-model cycle boundary.
- A task will span more than one session or runtime switch.
- A Scrum S3 verify or Recovery exit needs handover evidence before the next
  session begins.

## CURRENT.json anatomy

`ut-tdd handover` writes `.ut-tdd/handover/CURRENT.json`. The file contains:

| Field | What it records |
|---|---|
| `carry` | Items the previous session reported as incomplete |
| `completed` | Items the previous session reported as done |
| `open_plans` | PLAN IDs with non-terminal status |
| `session_digest` | Compressed event log from the closing session |

**Treat `carry` as a claim, not truth.** Before acting on it:

1. Run `git log --oneline -20` and cross-check completed work against actual
   commits.
2. Run `ut-tdd doctor` to confirm structural state.
3. Run `ut-tdd status` to see the current drive mode and open PLANs.
4. Any carry item that conflicts with `git log` or `doctor` output is stale —
   update or remove it before proceeding.

## Session-close procedure

At any PLAN completion or session boundary:

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
3. Check `open_plans` against `ut-tdd doctor` output — a PLAN listed as open
   but absent from governance is a stale handover entry.
4. Proceed with the verified carry, not the raw handover text.

## Session log and digests

The `SessionStart` and `Stop` hooks write to `src/runtime/session-log.ts`. Each
session compresses into a PLAN digest in `harness.db`. Digests are queryable via
`ut-tdd metrics` and `ut-tdd find`. Session log entries store metadata only —
never prompt text, credentials, or PII.

## Staleness and multi-session gaps

A `CURRENT.json` older than 24 hours should be treated as potentially stale.
Verify open items from scratch rather than propagating possibly outdated carry.
If multiple sessions have elapsed without a handover flush, run `ut-tdd db
rebuild` to re-project harness state from the current `docs/plans/` and
`.ut-tdd/` on-disk state.

## Anti-patterns

- Forwarding raw `CURRENT.json` carry to the PO without a `git log` cross-check
  — stale carry creates false incident reports.
- Skipping `ut-tdd handover` at a drive-cycle boundary — the next session starts
  blind.
- Storing session decisions in the handover file rather than in committed docs or
  ADRs — handover is continuity glue, not the authoritative record.
