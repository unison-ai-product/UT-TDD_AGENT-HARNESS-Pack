---
schema_version: skill.v1
name: dependency-map
skill_type: verification
applies_to:
  layers:
    - L3
    - L4
    - L5
    - L6
  drive_models:
    - Forward
    - Reverse
    - Add-feature
    - Refactor
decision_points:
  - when: "A change consumes an artifact owned by other work"
    choose: "Link the owning design revision and prerequisite Issue"
    over: "Leaving the dependency implicit in the source diff"
    because: "The upstream owner and revision are needed to review the change"
  - when: "A design dependency is unresolved at a freeze boundary"
    choose: "Resolve it or follow the applicable design deferral contract"
    over: "Passing the gate before recording the unresolved dependency"
    because: "Freeze evidence must account for prerequisites"
  - when: "A refactor claims no dependency changes"
    choose: "Compare the relevant imports, interfaces, and runtime dependencies on the base and submitted head"
    over: "Checking only whether tests pass"
    because: "A stable result set can coexist with a dependency change"
---

# dependency map

Trace upstream ownership and downstream impact before changing a module, contract, or design artifact.

## Map dependencies

1. Identify the exact base revision and the changed files or proposed design sections.
2. Follow code imports, interface callers, and design/test-design trace references. Check indirect consumers of the changed boundary.
3. Record the owning design revision, affected consumer, and order of work in the corresponding Issues. Cite any unresolved dependency and its owner. Apply the existing design rules for deferrals.
4. Check the links against the tracked artifacts and available trace or doctor checks. Recheck impacted call sites after the change.

## Refactor evidence

A dependency-neutral refactor checks imports and public interfaces on both revisions and verifies the affected tests. Record the comparison and any changed edges in the PR.

An L4 dependency record identifies the module or artifact, its owner and version or revision, the interface used, and the failure or fallback boundary.
