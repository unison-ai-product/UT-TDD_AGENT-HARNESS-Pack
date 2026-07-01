---
schema_version: skill.v1
name: git
skill_type: process
applies_to:
  layers:
    - L7
    - L8
    - L10
    - L12
    - L14
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Recovery
    - Refactor
    - Retrofit
---

# git

Conventional Commits discipline, harness-check CI requirements, branch and PR
rules, and the commit-msg hook for UT-TDD (FR-L1-17 version control).

## When to load this skill

- Preparing a commit after implementing or reviewing a PLAN.
- A `commit-msg` hook rejection needs diagnosis.
- A push will touch `.github/workflows/` and needs a workflow-scoped token.
- A CI `harness-check` failure must be resolved before gate clearance.

## Conventional Commits format

Every commit message must follow Conventional Commits or the `commit-msg` hook
will reject it:

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`,
`ci`, `perf`. Scope is the PLAN ID or module name (e.g., `PLAN-L7-44`,
`projection-writer`). The short description is imperative mood, no trailing
period.

**Bash heredoc is required** for multi-line commit messages — PowerShell
here-strings are not accepted by the hook:

```bash
git commit -F - <<'EOF'
feat(PLAN-L7-44): add harness.db projection for model_runs

Implements FR-L1-38 cost telemetry capture.
EOF
```

## Staging discipline

Stage explicit files only. Never use `git add -A` or `git add .` — these can
include `.ut-tdd/` runtime state, `.env` files, or generated artefacts that must
not enter the repository.

Verify before staging:

```
git status
git diff --stat
```

Confirm the diff contains only the files for the current PLAN.

## harness-check CI gates

CI runs `harness-check` on every push. All four must be green before a push:

| Check | Command | Common failure |
|---|---|---|
| Type check | `bun run typecheck` | Missing type declarations |
| Vitest | `bun run test` | Do NOT use bare `bun test` — sync-timeout flakiness |
| Biome | `bun run lint` | Format violations from `biome lint` without `biome check` |
| Doctor | `ut-tdd doctor` | Governance violations, missing PLAN dependencies |

Run all four locally before pushing. `biome lint` alone does not check
formatting — run `bun run lint` (which invokes `biome check`) to catch both.

## Branch strategy

- `main` is the integration branch. Direct commits to `main` are permitted for
  solo maintainer flow.
- Feature branches are used when work spans multiple sessions or requires a PR
  review gate (hybrid mode judgement).
- Branch names follow `<type>/<slug>` (e.g., `feat/plan-l7-44-projection`).

## Pushing with workflow changes

Commits touching `.github/workflows/` require a workflow-scoped PAT. The normal
GCM OAuth token is rejected by GitHub for workflow-file pushes. Use a temporary
credential override and remove it immediately after the push — do not persist
workflow-scoped tokens in config files or environment variables.

## Pre-push checklist

- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` (Biome check + format) exits 0.
- [ ] `bun run test` (Vitest) exits 0 with no skipped tests in PLAN scope.
- [ ] `ut-tdd doctor` exits 0.
- [ ] `git diff --stat HEAD` shows only PLAN-scoped files.
- [ ] Commit message accepted by `commit-msg` hook (Conventional Commits).
- [ ] If `.github/workflows/` touched: workflow-scoped PAT is in use and will be
      removed after push.
