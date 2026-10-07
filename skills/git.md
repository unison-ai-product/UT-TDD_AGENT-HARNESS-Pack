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
decision_points:
  - when: "Staging files for a commit"
    choose: "stage explicit file paths only"
    over: "using `git add -A` or `git add .`"
    because: "bulk staging can pull in `.ut-tdd/` runtime state, `.env` files, or generated artefacts that must never enter the repository"
  - when: "Writing a multi-line commit message"
    choose: "use a Bash heredoc (`git commit -F - <<'EOF' ... EOF`)"
    over: "using a PowerShell here-string"
    because: "there is no local `commit-msg` hook (CI `commitlint-invalid` is the enforcer); the Bash heredoc is advised only because PowerShell here-strings are error-prone for multi-line messages (quoting / line endings)"
  - when: "Verifying Vitest before pushing"
    choose: "run `npm run test`"
    over: "using an unspecified test command"
    because: "the repository's canonical test script is the deterministic Vitest snapshot runner"
  - when: "Checking format/lint before pushing"
    choose: "run `npm run lint` (invokes `biome check`)"
    over: "running `biome lint` alone"
    because: "`biome lint` alone does not check formatting; format violations pass locally and break `harness-check` on push"
  - when: "A commit touches files under `.github/workflows/`"
    choose: "use a temporary workflow-scoped PAT and remove it immediately after the push"
    over: "pushing with the normal GCM OAuth token, or leaving the workflow-scoped token persisted in config/env"
    because: "GitHub rejects workflow-file pushes from the normal OAuth token, and persisting a workflow-scoped credential is an unnecessary standing security exposure"
  - when: "Choosing between committing directly to `main` or opening a feature branch"
    choose: "always use a `<type>/<slug>` feature branch and merge via `ut-tdd pr merge --pr <N>`"
    over: "committing directly to `main` or calling `gh pr merge` directly"
    because: "PR merge only through the wrapper is a binding rule (CLAUDE.md §Git Rules); hybrid-mode review gates require the branch+PR path"
---

# git

Conventional Commits discipline, harness-check CI requirements, and branch and
PR rules for UT-TDD (FR-L1-17 version control).

## When to load this skill

- Preparing a commit after implementing or reviewing a PLAN.
- A CI `branch-type guard` (`commitlint-invalid`) rejection needs diagnosis.
- A push will touch `.github/workflows/` and needs a workflow-scoped token.
- A CI `harness-check` failure must be resolved before gate clearance.

## Conventional Commits format

Every commit message must follow Conventional Commits. CI rejects a subject that
does not (`commitlint-invalid`; regex `CONVENTIONAL_COMMIT_RE` at
`src/github/ops-guard.ts:41`, run by the `branch-type guard` step at
`.github/workflows/harness-check.yml:78`; there is no local `commit-msg` hook):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

Allowed types are those in `CONVENTIONAL_COMMIT_RE`. Scope is the PLAN ID or module name (e.g., `PLAN-L7-44`,
`projection-writer`). The short description is imperative mood, no trailing
period.

**Bash heredoc is required** for multi-line commit messages — PowerShell
here-strings are not reliable for this:

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

CI runs `harness-check` on every push; the sub-gates are defined in
`.github/workflows/harness-check.yml` (typecheck :106, doctor :114, test :134,
lint :155) and described in `ci-gate-design`. Run them locally before pushing
(see the pre-push checklist). `biome lint` alone does not check formatting — use
`npm run lint` (which invokes `biome check`).

## Branch strategy

- `main` is the integration branch. Work goes through a feature branch and PR;
  merge only via `ut-tdd pr merge --pr <N>`. PR scope (1 PR = 1 論点) and
  post-FLAG corrections in the same PR follow `CLAUDE.md` §Git Rules and
  §PR スコープ規律 / §FLAG 後の限定是正と merge (not restated here).
- Branch names follow `<type>/<slug>` (e.g., `feat/plan-l7-44-projection`).

## Pushing with workflow changes

Commits touching `.github/workflows/` require a workflow-scoped PAT. The normal
GCM OAuth token is rejected by GitHub for workflow-file pushes. Use a temporary
credential override and remove it immediately after the push — do not persist
workflow-scoped tokens in config files or environment variables.

## Pre-push checklist

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` (Biome check + format) exits 0.
- [ ] `npm run test` (Vitest) exits 0 with no skipped tests in PLAN scope.
- [ ] `ut-tdd doctor` exits 0.
- [ ] `git diff --stat HEAD` shows only PLAN-scoped files.
- [ ] Commit subject matches Conventional Commits (CI `commitlint-invalid`).
- [ ] If `.github/workflows/` touched: workflow-scoped PAT is in use and will be
      removed after push.
