---
schema_version: skill.v1
name: reverse-r3
skill_type: drive-reverse
applies_to:
  layers:
    - L1
    - L3
    - L4
  drive_models:
    - Reverse
    - Retrofit
    - Recovery
decision_points:
  - when: "A structural gap from R2 is already clearly covered by an existing Forward FR or ADR"
    choose: "Classify the hypothesis as confirmed and wire the trace to the existing artifact"
    over: "Classifying it as gap and drafting a new Forward document"
    because: "confirmed means Reverse only needs to connect the existing artifact, not author a new one"
  - when: "A structural gap from R2 has no Forward artifact covering it at all"
    choose: "Classify the hypothesis as gap with a draft_routing destination"
    over: "Classifying it as confirmed on the assumption that coverage exists elsewhere"
    because: "gap explicitly signals that a new or updated Forward document is needed at the routing destination"
  - when: "Observed behavior contradicts an existing Forward artifact"
    choose: "Classify the hypothesis as conflict and name the specific gate (G1/G3/G4/G5) to invalidate"
    over: "Silently noting the discrepancy without naming a gate"
    because: "R4's --invalidate-forward action needs the named gate to act on; an unnamed conflict cannot be routed"
  - when: "R3 is about to advance to R4 but PO has not reviewed the intent hypotheses"
    choose: "Block the advance until po_reviewed=true and po_review_evidence is populated"
    over: "Advancing to R4 on the hypotheses alone"
    because: "PO verification is mandatory for R3; ut-tdd plan lint machine-checks po_reviewed and treats a missing sign-off as a blocking violation"
  - when: "Drafting the forward_routing candidate for a gap"
    choose: "Select the routing layer using the reverse.md §4 routing table"
    over: "Choosing a layer ad hoc based on where the gap seems to fit"
    because: "The routing table encodes the established L1/L3/L4/L5/gap-only mapping rules for consistency across Reverse cycles"
  - when: "Recording PO sign-off for the intent hypotheses"
    choose: "Record it in the PLAN review_evidence field and in .ut-tdd/audit/"
    over: "Treating a chat discussion with the PO as sufficient evidence"
    because: "Only PLAN review_evidence and .ut-tdd/audit/ entries are machine-visible and verifiable at the R3-to-R4 gate"
---

# reverse r3

R3: Intent Hypotheses -- form the design-intent hypotheses and gap register
candidates that will feed R4 routing. PO verification is mandatory before
exiting R3 (FR-L1-14, reverse.md §2 and §5).

All 5 reverse types pass through R3 (no skip).

## When to load this skill

- The `kind=reverse` PLAN has `workflow_phase: R3`.

## Inputs

- `R2-as-is-design.md` (and `R2-as-is-test-design.md` if tests exist).
- `R1-observed-contracts.yaml` (code, upgrade, fullback types).
- `R0-evidence-map.yaml` drift signals.
- Existing Forward artifacts at any layer (requirements, ADRs, design docs) for
  the subject scope -- compare against the as-is to identify divergence.

## Procedure

1. For each structural gap identified in R2, hypothesize the original intent:
   - What requirement or design decision was this module/contract meant to
     satisfy?
   - Is there an existing Forward FR or ADR that covers it, partially covers it,
     or conflicts with it?
2. Classify each hypothesis:
   - `confirmed`: an existing Forward artifact clearly covers it -- Reverse
     simply needs to wire the trace.
   - `gap`: no Forward artifact covers it -- needs a new or updated Forward
     document at the routing destination.
   - `conflict`: the observed behavior contradicts an existing Forward artifact
     -- that artifact must be invalidated or amended.
3. For each `conflict`, identify the Forward gate that would be invalidated
   (G1/G3/G4/G5) and note it for R4 `--invalidate-forward` action.
4. Draft the `forward_routing` candidate for each gap (L1, L3, L4, L5, or
   gap-only). Use reverse.md §4 routing table as the decision guide.
5. Compile the draft `intent-hypotheses` document for PO review.

## PO verification (mandatory)

R3 cannot exit without PO sign-off. The PO reviews:
- Are the intent hypotheses plausible given the business context?
- Do gap classifications (`confirmed`/`gap`/`conflict`) match PO's understanding?
- Is the draft `forward_routing` selection appropriate?

Record PO review evidence in the PLAN `review_evidence` field and in
`.ut-tdd/audit/` before advancing.

## Output artifact: intent-hypotheses

Write to `.ut-tdd/reverse/<plan_id>/R3-intent-hypotheses.yaml`:

```yaml
plan_id: <PLAN-REVERSE-NN>
hypotheses:
  - id: <H-NN>
    subject: ""          # module, contract, or design element
    classification: <confirmed|gap|conflict>
    linked_forward_artifact: <PLAN-ID or FR-ID or null>
    conflict_gate: <G1|G3|G4|G5 or null>
    draft_routing: <L1|L3|L4|L5|gap-only>
    intent_summary: ""
po_reviewed: false        # set true after PO sign-off
po_review_evidence: ""    # path to evidence or inline note
r3_notes: ""
```

## Gate to R4

Before advancing `workflow_phase` to `R4`, verify:

- [ ] All structural gaps from R2 have a hypothesis entry.
- [ ] `po_reviewed: true` and `po_review_evidence` is populated.
- [ ] Conflict entries name the specific Forward gate to invalidate.
- [ ] Each hypothesis has a `draft_routing` value from the valid enum
  (L1/L3/L4/L5/gap-only).
- [ ] PLAN `review_evidence` field is updated with PO sign-off reference.
- [ ] `ut-tdd plan lint` exits 0 with `workflow_phase: R4`.
- [ ] `ut-tdd doctor` exits 0.

Advancing R3 without PO verification is a blocking violation. The `po_reviewed`
field is machine-checked by `ut-tdd plan lint` when the schema enforces it.
