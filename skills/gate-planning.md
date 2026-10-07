---
schema_version: skill.v1
name: gate-planning
skill_type: process
applies_to:
  layers:
    - L1
    - L3
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Scrum
    - Discovery
decision_points:
  - when: "Deciding whether a unit of work is complete"
    choose: "require all seven DoD conditions (typecheck/lint/test green, doctor 0, plan lint 0, review --uncommitted clean, freeze readability, glossary updated, handover if session-crossing)"
    over: "treating \"code written\" or \"looks right\" as sufficient to close"
    because: "only machine evidence and recorded review findings clear a gate; subjective code-looks-right assessments are not falsifiable"
  - when: "Running Vitest locally or in CI"
    choose: "use `npm run test`"
    over: "using an unspecified test command"
    because: "the repository's canonical test script is the deterministic Vitest snapshot runner"
  - when: "Checking Biome formatting before a gate"
    choose: "run `npm run lint` (which invokes `biome check`)"
    over: "running `biome lint` alone"
    because: "`biome lint` does not check formatting; format violations accumulate silently and break the next push"
  - when: "`ut-tdd doctor` exits 0 for a layer"
    choose: "treat that as structural governance passing only, and still read the design docs for substance"
    over: "treating doctor-green as confirmation the design itself is correct"
    because: "doctor checks structural governance (schema, dependencies, projections), not design substance — green doctor with a wrong design is possible"
  - when: "A judgement gate (pair-freeze, trace-freeze, accept) needs review evidence"
    choose: "obtain cross-agent review evidence in hybrid mode, or `intra_runtime_subagent` evidence in single-runtime mode"
    over: "self-review by the same agent/session that did the work"
    because: "self-review alone is explicitly excluded — mode-aware review tier exists precisely to prevent one agent from being both author and sole reviewer"
  - when: "A type error, lint violation, or skipped test blocks a gate"
    choose: "fix the underlying issue or get a PLAN-linked rationale recorded"
    over: "silencing with `// biome-ignore`, `// @ts-ignore`, or `.skip`"
    because: "unrationalized silencing defeats the enforcement the gate exists to provide and hides the condition from future review"
  - when: "An implementation PR must confirm its PLAN before merge"
    choose: "follow the confirm runbook (case A: empty commit + CI green; case B: logged local Node runs at the subject head), then a post-green evidence review, the confirm commit and a bookkeeping re-review"
    over: "dropping confirm, citing a pre-green review, or citing evidence that is not in the packet"
    because: "review-evidence requires tests_green_at <= reviewed_at and new deliverables stay orphan until the owning PLAN is confirmed (#856)"
---

# gate planning

How to author and enforce Definition-of-Done (DoD) gates in UT-TDD (FR-L1-05
deterministic static gate, FR-L1-13 Forward workflow). A gate is a
machine-checked boundary, not a skippable checklist — unenforced gates
accumulate false-green state and hide V-model descent gaps.

## When to load this skill

- Designing the acceptance conditions for a PLAN or a layer transition.
- A `ut-tdd doctor` failure exposes a condition that is not machine-checked.
- A Scrum S3 verify step needs explicit DoD before S4 decide.
- A pair-freeze / trace-freeze / accept gate is being crossed.
- An implementation PR has to confirm its PLAN before merge (see the confirm runbook below).

## UT-TDD Definition-of-Done

A unit of work is complete only when ALL hold:

1. The CI `harness-check` gate set is green (`.github/workflows/harness-check.yml` 全体: linux / windows / node-generation / 集約 `harness-check` job;
   locally `npm run typecheck`, `npm run lint`, `npm run test`).
2. `ut-tdd doctor` exits 0 (no governance violation).
3. `ut-tdd plan lint` exits 0 (PLAN schema valid, dependencies exist,
   `§工程表` schedule section checked).
4. `ut-tdd review --uncommitted` produces no blocking findings for the layer.
5. The layer's design doc passes the freeze readability check (Objective,
   Scope, no mojibake).
6. New terms are added to the L0 glossary.
7. Handover evidence is written to `.ut-tdd/handover/` when the task crosses a
   session boundary.

"Code written" and "looks right" are not DoD. Only machine evidence and recorded
review findings clear a gate.

## Gate design rules

- **Falsifiable condition.** "Passes review" is not falsifiable; "`ut-tdd
  doctor` exits 0 and `npm run test` passes with no skipped tests" is.
- **Name the checking command.** Every condition maps to a `ut-tdd`/CI command
  or an explicit human review action.
- **Record the result, not the intent.** Evidence goes into `.ut-tdd/audit/` or
  the PLAN `review_evidence` field; a gate with no recorded evidence is not
  cleared.
- **Split correctness from readability.** Schema-valid (`ut-tdd plan lint`) and
  readable (manual / `ut-tdd review --uncommitted`) are separate checks.

## Layer gate checklists

**pair-freeze (design → implement):** PLAN `status` ready; design doc exists at
the right `docs/design/` path and passes readability; `ut-tdd plan lint` and
`ut-tdd doctor` exit 0; no unresolved `requires` dependency.

**trace-freeze (implement → review):** PLAN-scoped source committed; Vitest green
with no skipped tests in scope; Biome check + typecheck exit 0; `ut-tdd doctor`
exit 0; `review_evidence` trace links populated.

**accept (review → done):** `ut-tdd review --uncommitted` no blocking findings;
trace-freeze conditions still green on HEAD; new ADR set to `Accepted`; handover
updated or closed.

## Confirming a PLAN at the end of an implementation PR (interim runbook, #856)

Two hard gates form a cycle on any PR that confirms its PLAN:

- `review-evidence` requires `tests_green_at <= reviewed_at` on every entry of a
  confirmed / completed PLAN (`src/lint/review-evidence.ts:307-317`), and, for
  `updated >= 2026-06-23`, a complete `green_commands` list
  (`src/lint/review-evidence.ts:94`, `:224-262`). So confirm needs a review taken
  **after** green.
- `orphan-deliverable` は、どの PLAN の `generates` にも無い `scripts/` 配下、
  除外対象外の `.claude/` 配下、`tests/**/*.test.ts` だけを対象にする
  (`src/lint/deliverable-plan-trace.ts:55-67`、収集 root は `:116`)。`src/` 配下の
  新規ファイルはここでは orphan にならない。また `generates` は PLAN の status を
  問わず読まれる (`:130-139`) ので、draft PLAN に載せても trace は通る。
- 別軸で、draft など未 confirm の PLAN が `src/` `tests/` `scripts/` `.claude/`
  の既存ファイルを `generates` に載せると `merged-plan-status` violation になる
  (`src/lint/merged-plan-status.ts:62`、`:106-127`、`:145-147`)。これは「orphan」
  ではなく「載せたまま draft」を弾く検査である。

Until the root fix (#648: deliverable ownership moves from PLAN `generates` to
the Design trace) use one of the two sequences below. Do not weaken either gate.

**Case A: the PR adds no new deliverable files** (precedent #854). CI can go
green before confirm.

1. Push an empty commit (`chore(review): ...`) as the evidence-review subject head.
2. Wait for the required CI on that head to finish green.
3. Request a post-green evidence review of that head (non-author family).
4. Confirm commit (`plan revise`): `tests_green_at` = the CI run end,
   `green_commands` with `runner: ci`, `completed_at <= tests_green_at`,
   `anchor_commit` = the subject head, `output_digest` = sha256 of the
   `evidence_path` blob at the anchor (`src/lint/green-command-digest.ts:58-74`).
5. Bookkeeping re-review of the confirm head (originals in the packet, below).
6. Merge through `ut-tdd pr merge`.

**Case B: the PR adds new `scripts/` / `.claude/` / `tests/**/*.test.ts` files
that only the confirming PLAN would own** (precedent #839). 適用条件は
`deliverable-plan-trace.ts:55-67` の対象パスに限る。confirm 前の head はこれらが
`orphan-deliverable` で red になり、CI を green 証跡にできない。`src/` だけの追加は
orphan にならないため Case A に従う (ただし draft PLAN の `generates` に既存
`src/` ファイルを載せない: `merged-plan-status.ts:62`)。

1. At the subject head, run locally under Node, logging each run with UTC start
   / end timestamps and the sha256 of its log: `npx tsc --noEmit`, `npx biome
   check <changed files>`, `node scripts/run-vitest-snapshot.ts <targeted tests>`.
   Put the logs in the packet evidence directory.
2. Request the evidence review of that head; the packet carries the logs.
3. Confirm commit (`plan revise`): add the new files to `generates`;
   `green_commands` with `runner: node` and `scope: targeted | full |
   changed-files` matching what was actually run (allowed values:
   `src/lint/review-evidence.ts:105-106`); `tests_green_at` = the last local
   run end, `reviewed_at` after it; `anchor_commit` = the subject head.
   `evidence_path` / `output_digest` は log ではなく、subject head に実在する
   tracked の source / test ファイルを指し、`output_digest` はその anchor 時点の
   blob の sha256 にする。`green-command-digest.ts:69-96` は
   `readBlobAtCommit(anchor, evidence_path)` の blob を hash して比較し、blob 不在は
   `anchor-path-missing`、不一致は `anchor-digest-mismatch` になる。log の hash は
   使えない (log は packet evidence に置くだけで tracked blob ではない)。log の
   sha256 は step 1 の記録として別に残す (#839 の confirm comment も blob hash と
   log hash を別に記載)。
4. Bookkeeping re-review of the confirm head.
5. The merge-ref CI on the confirm head must be green, then merge through
   `ut-tdd pr merge`.

**Packet originals.** Every receipt, revise manifest, base projection and run
JSON / log cited by the confirm goes into
`.ut-tdd/review/packets/pr<N>-<h8>/evidence/`. A citation the reviewer cannot
open is a FLAG (#854 r2).

**Caveats (advisor, #856).** Confirm does not replace the merge-ref CI or the
final closing review on the exact merge head. The local runs must cover
everything the review checks: a review that judges lint needs a biome log in
the packet (#839 head 73a861a3 was FLAGged for missing biome evidence).

## Mode-aware review tier

`ut-tdd gate <id>` resolves the execution mode via `detectMode()` (the same detection `ut-tdd status` reports; `--mode <mode>` overrides it for tests, `src/cli.ts`). Judgement gates
require cross-agent review evidence in hybrid mode, or `intra_runtime_subagent`
evidence in single-runtime mode — never self-review alone.

## Anti-patterns that defeat enforcement

- An unspecified test command instead of the repository's canonical `npm run test` script.
- `biome lint` without `biome check` — format violations accumulate and break the
  next push.
- Treating `ut-tdd doctor` green as "design is correct" — doctor checks
  structural governance, not design substance. Read the docs.
- Silencing with `// biome-ignore`, `// @ts-ignore`, or `.skip` without a
  PLAN-linked rationale.
