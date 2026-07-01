---
schema_version: skill.v1
name: security-and-hardening
skill_type: verification
applies_to:
  layers:
    - L3
    - L5
    - L7
    - L8
    - L9
    - L10
    - L11
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Retrofit
    - Refactor
---

# security and hardening

Hardening pass procedure: dependency supply-chain hygiene, secret redaction
verification, Biome security-lint rules, and runtime surface reduction. Distinct
from `security.md` (which covers escalation boundaries and agent-guard design);
this skill covers the systematic hardening sweep applied at L7 and above before
a PLAN crosses the accept gate.

## When to load this skill

- A PLAN adds or upgrades a runtime dependency (`package.json` changes).
- A Retrofit or Refactor PLAN must demonstrate the hardened surface is not
  expanded.
- `ut-tdd guardrail` exits non-zero after a dependency change.
- A harness release (L11/L12) requires a full hardening attestation.

## Hardening sweep checklist

Run in order before accept gate:

```
ut-tdd guardrail          # secret pattern scan across all text files
bun run lint              # Biome check: includes security-adjacent lint rules
bun run test              # Vitest: confirm no fixture file leaks credentials
ut-tdd doctor             # structural governance: no orphaned hook or agent path
```

### 1. Dependency supply-chain

For every new or updated entry in `package.json`:

- [ ] Confirm the package is from a known registry (npmjs.com). No `file:`,
      `git+ssh:`, or `http:` protocol references without PO approval.
- [ ] Run `bun audit` (or equivalent) and confirm zero critical or high severity
      advisories. If an advisory exists, document the accepted risk in
      `docs/design/L5/<plan-id>-dependency-risk.md` before accept.
- [ ] Confirm the version pin is not a floating range (`^x.y.z` is acceptable;
      `*` or `latest` is prohibited in production dependencies).

### 2. Secret and credential redaction

- [ ] `ut-tdd guardrail` exits 0 — no API key patterns, no session tokens, no
      personal absolute paths in committed files.
- [ ] `.env*` files are listed in `.gitignore`; confirm no `.env` is tracked.
- [ ] Vitest fixtures do not contain real credential-like strings. Use
      `"FAKE_KEY_FOR_TESTING"` sentinel strings; the guardrail should recognize
      and skip them — if it does not, file an improvement entry.

### 3. Biome security-lint surface

- [ ] `bun run lint` exits 0 with no suppressions added beyond the pre-change
      count.
- [ ] Any new `// biome-ignore` line has a PLAN-linked comment on the same line.
- [ ] `// @ts-ignore` and `// @ts-expect-error` lines are zero or PLAN-justified.

### 4. Runtime surface reduction

- [ ] No new global environment variables are introduced without updating
      `docs/design/` with the variable name, purpose, and expected value range.
      New harness-owned variables must use the `UT_TDD_` prefix.
- [ ] Hook entry points call only package-local `ut-tdd` commands. No personal
      absolute paths, no legacy tool names.
- [ ] No new network call in `src/` without an L5 design doc section describing
      the endpoint, authentication method, and failure behaviour.

### 5. Redaction audit for docs and audit artifacts

- [ ] All new files under `docs/`, `.ut-tdd/handover/`, and `.ut-tdd/audit/` are
      free of PII (names, email addresses, machine identifiers beyond repo-relative
      paths).
- [ ] No half-width kana, U+FFFD, or mojibake markers in new documentation files.
      Run a targeted readability scan before commit; the canonical detector is the doctor readability gate, which fails closed on half-width kana and U+FFFD replacement characters.

## Hardening attestation record

For Retrofit/Refactor PLANs and L11/L12 gates, write:

```
.ut-tdd/audit/<PLAN-id>-hardening.json
{
  "plan_id": "<id>",
  "gate": "accept | L12",
  "dependency_audit": "pass | advisory-accepted:<reference>",
  "guardrail": "pass | finding:<description>",
  "biome_clean": true | false,
  "surface_reduction": "no-expansion | expansion-justified:<reference>",
  "reviewer": "<agent-slug or intra_runtime_subagent>",
  "timestamp": "<ISO-8601>"
}
```

Link this file from the PLAN `review_evidence` field.

## Anti-patterns

- Running `ut-tdd guardrail` only at the end of a sprint — run it after every
  commit that touches `docs/`, `.ut-tdd/`, or `src/`.
- Treating a floating dependency range as "safe for now" without a PLAN to pin
  it — floating ranges are a supply-chain risk even in development.
- Conflating this skill with `security.md` — this skill is the *hardening sweep*
  (systematic, checklist-driven); `security.md` covers design-time escalation
  and agent-guard architecture. Both must be satisfied before accept.
