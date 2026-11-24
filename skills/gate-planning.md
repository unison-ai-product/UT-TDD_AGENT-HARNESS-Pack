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
    choose: "require the applicable CI, test, review, and design evidence for the Issue"
    over: "treating \"code written\" or \"looks right\" as sufficient to close"
    because: "only machine evidence and recorded review findings clear a gate; subjective code-looks-right assessments are not falsifiable"
  - when: "Running Vitest locally or in CI"
    choose: "run the targeted committed snapshot locally and the full regression suite in CI"
    over: "using an unspecified test command"
    because: "the local snapshot and the official CI run have an identifiable subject commit"
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
    choose: "fix the underlying issue or get an Issue-linked rationale recorded"
    over: "silencing with `// biome-ignore`, `// @ts-ignore`, or `.skip`"
    because: "unrationalized silencing defeats the enforcement the gate exists to provide and hides the condition from future review"
---

# gate planning

Define a verifiable completion condition for an Issue or V-model transition. Each condition names a command, a CI check, or a human review action and the evidence it must produce.

## Gate design

- State the expected outcome and the failure that the check detects.
- Check readability and structural integrity with the applicable doctor checks. Check the meaning of the design through review and the paired tests.
- Record results in the PR and its review custody or gate evidence. Include the subject commit and the relevant CI run or command output.
- Record a reviewed Issue rationale for an exception to an enforced check.

## Layer gates

**Pair-freeze.** The Issue identifies the design revision and paired test design. Check dependencies and readability and obtain the required review before implementation.

**Trace-freeze.** Commit the scoped implementation and tests. Verify typecheck, Biome, the targeted tests, applicable doctor checks, and required CI. Link the design and test evidence in the PR.

**Accept.** Verify the stated acceptance conditions against the PR head. Closing review uses the non-author family in hybrid mode and `intra_runtime_subagent` evidence in single-runtime mode. The review custody receipt and CI must match the submitted head. Use `ut-tdd pr merge` for the merge.

## Verification

Use `ut-tdd gate <id>` for the applicable gate, a targeted committed snapshot for local regression tests, and `harness-check` for the full CI run. `ut-tdd review --uncommitted` supplies the local review packet for changed files. When work crosses a session boundary, write the handover evidence.
