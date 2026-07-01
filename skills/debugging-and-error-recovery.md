---
schema_version: skill.v1
name: debugging-and-error-recovery
skill_type: process
applies_to:
  layers:
    - L7
    - L8
    - L9
    - L10
    - L11
    - L12
  drive_models:
    - Recovery
    - Incident
    - Forward
    - Add-feature
    - Reverse
---

# debugging and error recovery

Detection-to-routing protocol for defects and failures in UT-TDD (FR-L1-08
defect detection, FR-L1-10 recovery routing, FR-L1-16 incident classification).
This skill covers the triage and routing phase — once root cause is confirmed
and a PLAN is open, apply the error-fix skill for the fix itself.

## When to load this skill

- `ut-tdd doctor` exits non-zero and the root cause is not obvious.
- `bun run test`, `bun run typecheck`, or `bun run lint` fails on CI or locally.
- A runtime error appears in `.ut-tdd/` state or a hook entrypoint.
- An agent subagent output is inconsistent with expected harness state.
- A forced stop or unexpected session termination occurred (highest-severity
  Recovery signal).

## Detection sources and their meaning

| Signal | Tool | First action |
|--------|------|--------------|
| `ut-tdd doctor` non-zero | `ut-tdd doctor` | Read full output — never `| tail` |
| CI harness-check red | CI log | Identify sub-gate (typecheck / lint / test / doctor) |
| `.ut-tdd/` state inconsistency | `ut-tdd status` | Compare expected vs actual state |
| Hook entrypoint status null | `ut-tdd doctor` | Verify `PATH` includes System32 (Windows) |
| Subagent output mismatch | `git status` + file read | Check actual files, not agent narrative |

Always read the **full** output of a failing command. Truncating with `| head`
or `| tail` hides the root error — this has caused repeated false-diagnoses
where a downstream error message was treated as the root cause.

## Triage protocol

### Step 1 — classify the failure

Determine whether the failure is:

- **Environmental** — PATH, missing runtime, `.ut-tdd/` directory permissions,
  `CLAUDE_PROJECT_DIR` not set. Check `ut-tdd doctor` environment checks first.
- **Governance** — orphaned PLAN, missing design doc, broken dependency link,
  schema mismatch. Check `ut-tdd doctor` governance checks and `ut-tdd plan lint`.
- **Implementation** — a logic error in `src/`. Confirm with `bun run test` and
  a targeted test run.
- **Test oracle** — a test is asserting the wrong thing, or a false-green was
  accepted. Confirm by reading the test and the spec it should be testing.

Do not move to Step 2 until the class is clear. Misclassifying environmental
as implementation is a common source of wasted work.

### Step 2 — route to the correct PLAN type

| Class | Route |
|-------|-------|
| Environmental | Recovery PLAN; fix environment, add a `ut-tdd doctor` check for future detection |
| Governance | Recovery PLAN or inline fix depending on severity; update the relevant design doc |
| Implementation defect | Recovery PLAN (if severity warrants) or error-fix skill inline |
| Incident (production / user-visible) | Incident PLAN; priority over all other work |

A forced stop by the user is classified as Incident-level Recovery regardless
of apparent technical severity.

### Step 3 — reproduce before routing

Before opening a PLAN, confirm the failure is reproducible:

```
bun run typecheck
bun run lint
bun run test
ut-tdd doctor
ut-tdd status
```

Record the exact failing command, the first error line, and the HEAD SHA in the
PLAN's `review_evidence` field. "It failed earlier but I can't reproduce it"
is not a valid PLAN basis — diagnose the flakiness first.

## Recovery routing checklist

- [ ] Failure class identified (environmental / governance / implementation /
  oracle).
- [ ] Failure is reproducible on current HEAD.
- [ ] Failing command and first error line recorded in PLAN or `.ut-tdd/audit/`.
- [ ] Correct PLAN type opened (Recovery / Incident / inline fix).
- [ ] Root cause documented — what condition allowed the defect, not only what
  the symptom was.
- [ ] Prevention measure identified for after the fix (see error-fix skill).

## Iron Law and 3-attempt escalation (PLAN-RECOVERY-05)

Source concept: the `systematic-debugging` skill from obra/superpowers (reference
only — the rule below is authored from UT-TDD's Recovery/troubleshoot drive, not
imported).

**Iron Law — no fix without root-cause first.** Before changing code, complete
the root-cause pass: read the error fully, reproduce on HEAD, trace the bad value
upstream to its origin, and write a single specific hypothesis. State one
hypothesis, change one variable, verify before the next. The Recovery exit
contract already requires a prevention measure; this makes root-cause a *gate in
front of the fix*, not only a post-hoc note.

**3-attempt architectural escalation (hard stop).** If the same subject (file,
gate, or test) fails **3 consecutive times**, STOP fixing. Three failed attempts
mean the working hypothesis — or the architecture — is wrong, not that the next
tweak will land. Escalate: re-run the root-cause pass one level up (design /
contract / baseline), or open a Recovery PLAN. A success on the subject resets
the streak.

This is mechanized by `src/runtime/attempt-escalation.ts`
(`evaluateAttemptEscalation`): it counts consecutive `error` outcomes per subject
from the session log and emits a STOP signal at the threshold (default 3). The
signal is a `finding`, so it reaches the agent through the takeover feedback
surface (PLAN-L7-110) on the next session start — feedback from the DB, not prose.

> Worked example (2026-06-23): a takeover session measured a shared, concurrently
> mutated working tree repeatedly, got shifting test counts, and chased each shift
> with a new fix while blaming the other runtime. The Iron Law (anchor to HEAD,
> root-cause the moving baseline first) and the 3-attempt stop would have halted
> the spiral after the third re-measurement.

## Doctor signal catalogue

Common `ut-tdd doctor` non-zero causes and their meaning:

- **plan-governance**: orphaned PLAN, missing `requires` target, broken pair.
  Read the full governance output; each line is a separate violation.
- **readability**: mojibake marker (`U+FFFD`, half-width kana) detected in a
  doc. Do not attempt to reconstruct from a lossy conversion — restore from
  git history before the encoding error was introduced.
- **env-path**: `PATH` is missing a required directory. On Windows, verify
  `System32` is present; `ut-tdd doctor` will emit the missing segment.
- **descent-obligation**: an L7 source file has no paired L5/L6 design doc.
  Do not create a stub doc to pass the check — write the actual design.

## Anti-patterns

- Treating `ut-tdd doctor` green as "nothing is wrong" — doctor checks
  structural governance; a false-green gate (coverage without substance) can
  co-exist with a real defect.
- Fixing the symptom without identifying root cause — the Recovery exit contract
  requires a prevention measure, not only a symptom removal.
- Opening a new PLAN without a reproducible failure — creates governance noise
  and makes future triage harder.
- Diagnosing from agent narrative output — always verify with `git status`,
  file reads, and `ut-tdd status` against actual harness state.
