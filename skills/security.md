---
schema_version: skill.v1
name: security
skill_type: verification
applies_to:
  layers:
    - L2
    - L3
    - L5
    - L6
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
    - Incident
decision_points:
  - when: "A PLAN would modify authentication, authorization, the agent-guard allowlist, or `UT_TDD_ALLOW_RAW_AGENT=1` bypass paths."
    choose: "stop the PLAN, document the boundary crossed in `.ut-tdd/audit/`, and wait for explicit PO confirmation"
    over: "proceeding with implementation and recording the change in normal review_evidence"
    because: "these are named escalation boundaries; the file states escalation means stopping the PLAN, not just annotating it after the fact."
  - when: "`agent-guard.ts` receives an agent call with an unknown `subagent_type` or missing `model` field."
    choose: "exit 1 (fail-close)"
    over: "exiting 0 and logging a warning"
    because: "the file states fail-close is the only safe default for an unrecognized agent type or missing model — a fail-open path would let an unvetted agent execute."
  - when: "`UT_TDD_ALLOW_RAW_AGENT=1` is used to bypass agent-guard."
    choose: "require it to write evidence to `.ut-tdd/audit/` every time, treating it as an emergency bypass"
    over: "treating it as a normal operational flag usable without an audit trail"
    because: "the anti-patterns section names this exact conflation as a security defect — repeated undocumented use erodes the escalation-boundary guarantee."
  - when: "A hook exits 0 despite encountering an internal error condition."
    choose: "classify this as a security defect requiring the failure mode to be enumerated in the L5 design doc"
    over: "treating a quiet exit 0 as acceptable graceful degradation"
    because: "the file states a hook that exits 0 on error is a security defect by definition — fail-close is the required behavior for hook execution."
  - when: "A pre-push secret-scan finding (src/lint/secret-scan.ts) surfaces on a committed file."
    choose: "fix the root cause before accept"
    over: "silencing the finding with a comment or suppression"
    because: "the anti-patterns section states silencing with a comment instead of fixing the root cause is prohibited — the fix must land before accept, not be deferred by suppression."
  - when: "`ut-tdd doctor` reports a hook failing due to PATH/System32 issues on Windows."
    choose: "verify with `ut-tdd doctor` first before treating it as a code regression"
    over: "assuming the hook logic itself is broken and starting a code fix"
    because: "the file explicitly separates PATH integrity failures (environment) from code regressions; misdiagnosing wastes effort and risks masking the real environmental cause."
---

# security

Security review procedure for UT-TDD: escalation boundaries, agent-guard design,
secret hygiene, and runtime safety constraints (FR-L1-09 safety design, FR-L1-17
escalation, FR-L1-45 guardrail). Applies at every layer where a PLAN introduces
an agent-callable surface, modifies trust boundaries, or touches credential-
adjacent state.

## When to load this skill

- A PLAN modifies `.claude/settings.json` (agent allowlist or hook configuration).
- A new `ut-tdd` command or MCP endpoint is added.
- The pre-push secret scan (`scripts/git-hooks/pre-push` → `src/lint/secret-scan.ts`) exits non-zero.
- A Recovery or Incident PLAN requires proof that the exploit path is closed.
- An Add-feature PLAN touches authentication, authorization, session state, or
  external API assumptions.

## Escalation boundaries (do not cross without explicit PO sign-off)

These operations require escalation before any implementation proceeds:

- Modifying authentication or authorization logic.
- Changing the agent-guard allowlist in `.claude/settings.json`.
- Adding or removing `UT_TDD_ALLOW_RAW_AGENT=1` bypass paths.
- Writing to production infrastructure state or external API configuration.
- Changing how `.ut-tdd/` audit evidence is written or retained.
- Processing or storing PII in any harness artifact.

Escalation means stopping the current PLAN, documenting the boundary crossed in
`.ut-tdd/audit/`, and waiting for explicit PO confirmation before continuing.

## Agent guard security requirements

The `agent-guard.ts` hook enforces:

1. `subagent_type` must be in the allowlist (currently 14 named agents). Any
   unknown type exits 1 — fail-close is the only safe default.
2. Agent calls without a `model` field are rejected.
3. The model family must match the agent frontmatter declaration.
4. Bypass requires `UT_TDD_ALLOW_RAW_AGENT=1` AND must write evidence to
   `.ut-tdd/audit/`.
5. Invalid stdin JSON fails closed — silently ignoring parse errors is
   prohibited.

When reviewing a PLAN that modifies agent-guard behaviour, verify each of these
five rules is still enforced after the change.

## Secret and credential hygiene

The actual secret scan runs in the `pre-push` git hook
(`scripts/git-hooks/pre-push`), which inspects each pushed commit's blobs via
`src/lint/secret-scan.ts` (`analyzeSecretScan`). `ut-tdd guardrail` is **not** a
scanner — it is the guardrail decision ledger (`ut-tdd guardrail status` lists
recorded guardrail decisions from harness.db).

Before any commit that touches `docs/`, `.ut-tdd/`, handover files, or audit
evidence, check for:
- No strings matching API key patterns in any text file under the repo.
- No `UT_TDD_ALLOW_RAW_AGENT=1` left in committed scripts (should be env-only).
- No credential or session token in `.ut-tdd/handover/CURRENT.json`.
- No personal absolute path that encodes a username or machine name in a
  committed config file.

If `src/lint/secret-scan.ts` does not cover a pattern you found, file an
improvement entry and add a Vitest test fixture for the new pattern.

## Runtime safety constraints

- **Native Windows first-class.** Hook execution on Windows must not assume WSL2
  is available. Paths use `CLAUDE_PROJECT_DIR`, not personal absolute paths.
- **PATH integrity.** If `System32` is not on the runner PATH, hook entry points
  fail with status null — verify with `ut-tdd doctor` before treating it as a
  code regression.
- **Hook fail-close.** A hook that exits 0 on an error condition is a security
  defect. Every hook failure mode must be enumerated in the L5 design doc for
  that hook.

## Security review evidence

Record in the PLAN `review_evidence` field:

```
reviewer: <agent-slug or "intra_runtime_subagent">
gate: trace-freeze | accept
security_axis:
  escalation_boundaries: <not crossed | crossed and escalated>
  agent_guard_rules: <all 5 pass | finding>
  credential_hygiene: <secret-scan-pass | finding>
  hook_fail_close: <verified | finding>
outcome: PASS | FAIL | CONDITIONAL
timestamp: <ISO-8601>
```

## Anti-patterns

- Modifying `.claude/settings.json` as a "quick config change" without running
  the secret scan and recording review evidence.
- Treating `UT_TDD_ALLOW_RAW_AGENT=1` as a normal operational flag — it is an
  emergency bypass that must leave an audit trail every time it is used.
- Silencing a secret-scan finding with a comment instead of fixing the
  root cause — the fix must land before accept.
