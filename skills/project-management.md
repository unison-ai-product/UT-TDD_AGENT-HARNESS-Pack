---
schema_version: skill.v1
name: project-management
skill_type: process
applies_to:
  layers:
    - L1
  drive_models:
    - Forward
    - Add-feature
    - Discovery
    - Scrum
    - Reverse
    - Recovery
    - Incident
decision_points:
  - when: "A proposed Issue overlaps existing work"
    choose: "Extend the Issue that owns the outcome when appropriate"
    over: "Creating another Issue with the same deliverable"
    because: "Each outcome needs a clear owner"
  - when: "Work is being scheduled in parallel"
    choose: "Check prerequisites and shared write paths before scheduling child Issues together"
    over: "Starting parallel work from labels alone"
    because: "Shared files and dependencies can invalidate the order"
  - when: "A parent Issue is ready to close"
    choose: "Verify its own acceptance conditions and the completion of required child Issues"
    over: "Closing the parent when its first implementation merges"
    because: "The parent describes the full outcome"
---

# project management

Use GitHub Issues and the project roadmap to track milestone outcomes, ownership, and dependencies. Follow the repository's Issue hierarchy rules.

## Sequence work

- Search for an existing owner of the outcome. Use formal sub-issues for bounded deliverables under the owning Issue.
- Record dependency links, serial reasons, and the files shared by concurrent work. Resolve dependency cycles before starting the affected work.
- Track Add-feature and Reverse pairing through the relevant design and Issue links. For Recovery work, identify the affected gates and the evidence for resuming work.
- Compare open Issues and PRs with the roadmap and verify merged work against the committed head and its CI.

## Close a milestone

Reconcile each outstanding item with its current Issue and PR. Record unresolved dependencies and the next owner in the handover. Close the parent only when its acceptance conditions and required child work are complete.
