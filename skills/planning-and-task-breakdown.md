---
schema_version: skill.v1
name: planning-and-task-breakdown
skill_type: orchestration
applies_to:
  layers:
    - L1
    - L3
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
  - when: "a candidate schedule step cannot be verified at unit-test-design (L6/L7) granularity"
    choose: "split the step further until each step pairs with one design doc and one test-design doc"
    over: "keep the step coarse (e.g. \"implement everything\") and rely on review to catch gaps later"
    because: "a step too large to verify at L6/L7 granularity hides missing V-model pairing until doctor or review surfaces it downstream"
  - when: "a step has a distinct outcome and acceptance conditions"
    choose: "create a formal GitHub sub-issue under the outcome Issue"
    over: "leaving an independently verifiable outcome as an implicit schedule step"
    because: "the child Issue makes ownership, prerequisites, and verification visible"
  - when: "authoring §工程表 steps around pair-freeze and trace-freeze"
    choose: "mark the pair-freeze and trace-freeze review steps `[直列]` (serial gates)"
    over: "mark all steps `[並列]` to maximize apparent throughput"
    because: "a schedule with no serial gate around pair-freeze/trace-freeze is a decomposition error — gates must complete in order to be gates at all"
  - when: "an Issue is ready to close"
    choose: "check the acceptance conditions, required child Issues, and evidence on the PR"
    over: "closing the Issue once a patch exists"
    because: "the completion conditions require evidence of the intended outcome"
---

# planning and task breakdown

Break a feature or requirement into work that can be reviewed and verified against a design/test-design pair. Record active work in a GitHub Issue and link the exact governing design revision.

## Decompose the work

- Search existing Issues for the same outcome. Extend the existing Issue if the scope matches.
- Use a formal GitHub sub-issue for work that has a distinct deliverable and acceptance conditions. In-repo hierarchy rules live in `docs/governance/github-issue-hierarchy.md`.
- Keep the contract in `docs/design/` or `docs/test-design/`. The Issue links prerequisites, deliverables, the verification pair, and completion conditions.
- Split work until each implementation step can be verified against a known design section and its test design. For Add-feature work, record the applicable Reverse pairing in the Issue. For a PoC, identify S2 and S3 explicitly.

## Schedule and verify

1. [並列] Establish the L6 function design and the matching L7 test design.
2. [直列] Review and freeze the pair before implementing. Cite the design revision in the Issue.
3. [直列] Implement and verify the scoped change. Link the tests and CI to the PR.
4. [直列] Review the exact head and accept the work once its completion conditions are met.

Steps with separate files and prerequisites can run concurrently. State the reason for serial dependencies. Before closing an Issue, verify its acceptance conditions and the completion of required child Issues.
