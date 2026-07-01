---
schema_version: skill.v1
name: reverse-r0
skill_type: drive-reverse
applies_to:
  layers:
    - L3
    - L4
    - L5
  drive_models:
    - Reverse
    - Retrofit
    - Recovery
---

# reverse r0

R0: Evidence Acquisition -- the first phase of every Reverse cycle (FR-L1-14,
reverse.md §2). R0 is mandatory for all 5 reverse types. Its output is the
evidence map that gates entry to R1 (or R2 when R1 is skipped).

## When to load this skill

- The `kind=reverse` PLAN has just been created and `ut-tdd plan lint` is green.
- R0 is the current `workflow_phase` in the PLAN frontmatter.

## Inputs

- Existing source files, configuration, and migration snapshots under the
  subject scope (read-only; treat vendor snapshots as reference only).
- `ut-tdd status` output confirming no unresolved blocking state.
- `ut-tdd doctor` output to surface any pre-existing governance violations
  (record them; do not fix them during R0 -- that is R4's job).

## Procedure

1. List all artifacts in scope: source files, design docs, test files, schema
   files, dependency manifests.
2. For each artifact, record its location, approximate last-modified signal
   (git log), and whether it has a Forward-anchored PLAN trace.
3. Set `has_existing_tests` flag:
   - `true` if any test files cover the subject scope.
   - `false` if no test files found (or coverage is zero for the subject).
4. Inventory all test files relevant to the subject and list their paths.
5. Note any drift signals observed: schema mismatch, orphaned design docs,
   broken import paths, untraced implementation files.
6. Run `ut-tdd graph` or `ut-tdd find` to identify dependency edges if the
   subject scope involves inter-module contracts.

## Output artifact: evidence map

Write to `.ut-tdd/reverse/<plan_id>/R0-evidence-map.yaml`:

```yaml
plan_id: <PLAN-REVERSE-NN>
reverse_type: <code|design|upgrade|normalization|fullback>
has_existing_tests: <true|false>
test_files: []          # list paths; empty if has_existing_tests=false
artifacts:
  - path: <relative path>
    kind: <source|design|test|schema|config>
    forward_trace: <PLAN-ID or null>
drift_signals: []       # describe each observed divergence
r0_notes: ""
```

## Gate to R1 (or R2)

Before advancing the PLAN `workflow_phase` from `R0` to `R1` (or `R2` if the
type skips R1), verify:

- [ ] `R0-evidence-map.yaml` exists and is complete (no null fields except
  intentional).
- [ ] `has_existing_tests` is explicitly set (not omitted).
- [ ] All drift signals are listed (even if unresolved -- resolution is R3/R4).
- [ ] `ut-tdd plan lint` exits 0 with the updated PLAN `workflow_phase: R1`
  (or `R2` for design/normalization types).
- [ ] `ut-tdd doctor` exits 0 (no new violations introduced by R0 edits).

Advance PLAN `workflow_phase` only after all checks pass. Do not proceed to R1
or R2 with an incomplete evidence map.
