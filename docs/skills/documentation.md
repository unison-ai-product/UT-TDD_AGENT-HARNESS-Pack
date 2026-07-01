---
schema_version: skill.v1
name: documentation
skill_type: process
applies_to:
  layers:
    - L1
    - L2
    - L3
    - L4
    - L5
    - L6
    - L8
  drive_models:
    - Forward
    - Reverse
    - Add-feature
    - Retrofit
---

# documentation

Writing and maintaining README files, onboarding guides, runbooks, and doc-tree
prose in UT-TDD. Apply when producing human-readable operational documentation
as distinct from V-model design docs or ADRs (those are covered by
`documentation-and-adrs`).

## When to load this skill

- Writing or updating a `README.md`, onboarding guide, or CLI usage reference.
- Authoring a runbook for a recurring operational procedure (e.g., PAT rotation,
  `harness.db` rebuild, doctor triage).
- A new `ut-tdd` command needs a usage section in an existing doc.
- Doc maintenance after a PLAN introduces new commands, flags, or state paths.

## Scope: what this skill covers

| In scope | Out of scope |
|---|---|
| README / onboarding prose | V-model design docs (`docs/design/`) |
| CLI usage references | ADR authoring (see `documentation-and-adrs`) |
| Runbooks and operational procedures | PLAN files (`docs/plans/`) |
| doc-tree maintenance (dead links, stale paths) | L0 glossary back-merge (see `gate-planning`) |

## Writing standards

- **Active voice, named actor.** "Run `ut-tdd doctor`" not "The doctor command
  should be run."
- **Executable examples.** Every code block must be a command or output that
  actually works against the current codebase. Pseudocode must be labelled as
  such.
- **No version-drift.** If a command flag changes, update the doc in the same
  commit. A doc that describes a removed flag is worse than no doc.
- **Encoding: UTF-8 without BOM.** Half-width kana (U+FF61–FF9F) and U+FFFD are
  mojibake markers — scan with grep before committing any doc that passed through
  an external editor.

## README structure baseline

A UT-TDD README needs at minimum:

1. **Purpose** — one paragraph: what this component does and which system it
   serves.
2. **Prerequisites** — `bun`, `ut-tdd`, any external dependencies with minimum
   versions.
3. **Quick start** — the minimum command sequence to get a working state.
4. **Key commands** — a table of the most-used `ut-tdd` commands for this
   context.
5. **Troubleshooting** — the 2–3 most common failures and their remediation
   (`ut-tdd doctor` triage first).

## Runbook structure baseline

1. **Trigger** — the exact condition that causes this runbook to be invoked.
2. **Impact** — what breaks or degrades while the condition persists.
3. **Steps** — numbered, each with a command or decision and its expected output.
4. **Verification** — how to confirm the procedure succeeded (`ut-tdd doctor`,
   `ut-tdd status`, or a targeted test).
5. **Escalation** — when to stop and involve a human decision.

## Doc maintenance after a PLAN ships

When a PLAN adds or changes a `ut-tdd` command, flag, or state path:

1. Search existing docs for references to the old command / path using `grep`.
2. Update each reference in the same commit as the implementation.
3. If the change is breaking (old command no longer works), add a migration note
   under a `## Migration` heading rather than silently replacing the old text.

## Mojibake check before commit

```bash
# Scan for half-width kana and replacement character in docs/
grep -rP "[\xFF61-\xFF9F\xEF\xBF\xBD]" docs/
```

A clean result means no mojibake markers. A dirty result means the file was
corrupted in transit — restore from the last clean git revision rather than
attempting lossy character repair.
