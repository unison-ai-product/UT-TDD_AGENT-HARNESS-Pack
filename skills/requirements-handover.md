---
schema_version: skill.v1
name: requirements-handover
skill_type: process
applies_to:
  layers:
    - L1
    - L3
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
    - Reverse
    - Recovery
decision_points:
  - when: "A session ends with unfinished requirements work"
    choose: "Verify carry items against the current Issue, PR, and committed revision"
    over: "Copying the previous handover as current state"
    because: "Later commits or decisions can supersede the handover"
  - when: "A requirement is ambiguous at the L1 to L3 boundary"
    choose: "Record the open question and its owner on the Issue and in the relevant design"
    over: "Allowing a guess to become an L3 requirement"
    because: "The receiving session needs the observed gap and decision boundary"
  - when: "A PoC decision changes an L3 requirement"
    choose: "Link the PoC Issue and its evidence from the affected design or Issue"
    over: "Carrying the decision only in prose handover"
    because: "The requirement needs a durable source for the decision"
---

# requirements handover

Carry L1 and L3 requirements across sessions using the current GitHub Issue, the exact design revision, and the verification evidence. The local handover points to those artifacts.

## Prepare the handover

1. Reconcile the carry list with Git history and the current Issue and PR state.
2. Identify the requirement IDs, frozen design revision, affected test design, and the next owner.
3. Record unresolved clarification or deferral in the Issue and link the relevant requirement section. Include the evidence or question that will resolve it.
4. Link any applicable PoC decision and its verification evidence.
5. Record the remaining action with the Issue or PR, then use `ut-tdd handover` for continuity.

At the start of the next session, verify that the links and revision still describe the current work. Use the scoped doctor checks and CI results that cover the handed-off requirement.
