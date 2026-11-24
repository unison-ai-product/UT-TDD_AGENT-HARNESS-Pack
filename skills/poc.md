---
schema_version: skill.v1
name: poc
skill_type: verification
applies_to:
  layers:
    - L1
    - L2
  drive_models:
    - Discovery
    - Scrum
    - Forward
decision_points:
  - when: "A PoC result supports adoption"
    choose: "Open or link the follow-up implementation Issue and its design evidence"
    over: "Shipping the experimental code as production implementation"
    because: "Production work has its own design and verification gates"
  - when: "PoC evidence is being collected"
    choose: "Record input, method, observed values and command or artifact"
    over: "Recording a conclusion without measurements"
    because: "The reviewer needs comparable evidence for the hypothesis"
  - when: "S3 evidence is inconclusive"
    choose: "Record defer and the evidence needed to reconsider"
    over: "Selecting adopt to end the time box"
    because: "The decision needs evidence that resolves the hypothesis"
---

# PoC

Use a time-boxed Discovery cycle to resolve a specific uncertainty. Track the hypothesis, decision criteria, results, and decision in the PoC Issue.

| Phase | Result |
|---|---|
| S0 backlog | State the question, hypothesis, and affected requirement. |
| S1 plan | Set a time box, reference inputs, and name the measurements and success criteria. |
| S2 PoC | Run the experiment within the scope and record the environment, command, and observations. |
| S3 verify | Compare the evidence with the stated criteria. Identify inconclusive or counterexample results. |
| S4 decide | Record adopt, reject, or defer, with the rationale and next action. |

Adoption links to a follow-up design and implementation Issue. Rejection records what disproved the hypothesis. Deferral identifies the missing evidence and the condition that reopens the decision. Record the work state in the handover if it crosses a session.
