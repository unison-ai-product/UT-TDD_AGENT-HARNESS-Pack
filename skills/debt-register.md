---
schema_version: skill.v1
name: debt-register
skill_type: process
applies_to:
  layers:
    - L4
    - L5
    - L6
    - L7
  drive_models:
    - Forward
    - Add-feature
    - Refactor
    - Retrofit
    - Recovery
decision_points:
  - when: "An implementation needs a temporary exception"
    choose: "Track the exception in a GitHub Issue and link it from the originating change"
    over: "Leaving the exception in a code comment alone"
    because: "An Issue records the owner, impact, and removal date"
  - when: "A provisional decision reaches its expiry date"
    choose: "Remove the exception or record a reviewed extension and its next deadline"
    over: "Keeping the old deadline after deciding to defer"
    because: "The expiry is a trigger to review the remaining risk"
  - when: "Technical debt and a new requirement affect the same area"
    choose: "Track the Refactor or Retrofit and the feature as separate work items"
    over: "Mixing the feature into the debt discharge"
    because: "Each work item needs its own acceptance evidence"
---

# debt register

Track debt and temporary exceptions with a GitHub Issue. Use an existing Issue when it covers the same obligation.

## Record the debt

- Link the originating Issue or PR and the affected design or code.
- State the reason for the exception, its impact, the owner, and its expiry or removal condition.
- Identify a remediation step and the test or review evidence that will show the exception is gone.
- For an allowed suppression or skipped test, keep a traceable Issue reference alongside the rationale.

## Review and discharge

Review open debt at the agreed checkpoint. If an exception expires, remove it with verification or record the approved extension and a new expiry on the Issue. Apply the Refactor or Retrofit workflow to the discharge and give new behaviour its own Issue. Close the debt Issue after the evidence meets its completion conditions.
