---
schema_version: skill.v1
name: adversarial-review
skill_type: review
applies_to:
  layers:
    - L2
    - L3
    - L4
    - L5
    - L6
    - L7
    - L8
    - L10
    - L12
  drive_models:
    - Forward
    - Add-feature
    - Reverse
    - Recovery
    - Refactor
decision_points:
  - when: "ut-tdd doctor and ut-tdd vmodel lint are both green at a gate"
    choose: "read the design doc body and verify the claim is substantiated"
    over: "accepting green doctor/lint output as proof the content is correct"
    because: "doctor and lint check structure, not substance — coverage without substance is a named failure mode"
  - when: "a biome-ignore or ts-ignore suppression appears in the diff"
    choose: "fail the review unless the suppression carries a PLAN-linked rationale"
    over: "letting an unexplained suppression pass because the rest of the diff is clean"
    because: "unexplained suppressions are gate evasion and defeat the purpose of the lint gate"
  - when: "reviewing a PLAN in hybrid mode"
    choose: "require a different runtime or subagent family as the reviewer"
    over: "accepting self-review as the only recorded review evidence"
    because: "self-review as sole evidence in hybrid mode is an explicit anti-pattern — hybrid exists to get an independent check"
  - when: "only part of the PLAN's diff changed since the last review pass"
    choose: "review the full PLAN scope again"
    over: "reviewing only the partial diff since the last pass"
    because: "running review on a partial diff is a named anti-pattern that can miss regressions in already-touched files"
  - when: "an L6 test-design doc is missing for a new function but L7 code already exists"
    choose: "record it as an open obligation in review_evidence"
    over: "treating the working L7 implementation as sufficient evidence of coverage"
    because: "absent layer artifacts must be surfaced even when downstream code exists, per the trace-completeness check"
  - when: "a gate has no recorded review_evidence entry"
    choose: "treat the gate as not cleared"
    over: "treating ut-tdd doctor green as implicit gate clearance"
    because: "a gate with no recorded evidence is not cleared, regardless of doctor status"
  - when: "an attacker's finding is 'this seems ambiguous' or 'this looks insufficient' with no concrete scenario attached"
    choose: "reject it as not-an-attack and require the attacker construct the actual counterexample (a two-reading split, an uncovered input/state/order, an unreconstructable evidence trail, or a green-tests-but-unmet-requirement scenario)"
    over: "accepting a vague concern as valid review pressure toward a FLAG"
    because: "only four attack types are valid and all four are constructive; 'seems ambiguous' is explicitly excluded, and accepting it lets qualitative hand-waving substitute for a falsifiable claim."
  - when: "a defender wants to dismiss an attack but the provided packet text does not clearly exclude it"
    choose: "leave the refutation blank and record the attack as unrefuted"
    over: "writing a refutation based on inferred intent, common sense, or context outside the packet"
    because: "the defender may refute only by quoting the packet; conceding when no quote excludes the counterexample is the correct verdict, not a defender failure, and a refutation built on outside context cannot be re-verified by anyone reading the record later."
  - when: "a review pass records no_attack for an artifact"
    choose: "require at least 3 logged attempted-attack failures before accepting no_attack, and treat the outcome as PASS-WEAK — a priority target for the human spot-check tier, not an equal-strength PASS"
    over: "treating a bare no_attack claim as equivalent to a clean PASS, or accepting it with no attempt log"
    because: "no_attack without >=3 logged attempts is treated as OPEN; even a properly logged no_attack is not proof of safety, only evidence that this particular attacker found nothing, which is why it is prioritized for human review instead of trusted as strongly as a survived attack."
  - when: "selecting who plays attacker/defender, or reporting what a PASS verdict means"
    choose: "exclude the artifact's author model/session from both roles, and report PASS as 'survived this attacker' only"
    over: "letting the authoring session self-attack or self-defend for convenience, or reporting PASS as a general safety/quality guarantee"
    because: "models in the same family have correlated blind spots and the author cannot be an independent adversary against its own work; PASS carries no meaning beyond having survived the specific attacker that ran, not a general correctness proof."
---

# adversarial review

Independent, assumption-challenging review required at judgement gates G2, G4,
G5, G6, and G7 in the Forward cycle (FR-L1-13 workflow, FR-L1-21 cross-agent
review). Adversarial review differs from self-review: the reviewer actively
attempts to falsify the work rather than confirm it.

## When to load this skill

- Crossing a pair-freeze, trace-freeze, or accept gate in hybrid or
  intra-runtime-subagent mode.
- A `ut-tdd review --uncommitted` finding is ambiguous and needs independent
  judgement.
- A Recovery cycle must demonstrate that the original failure path is closed.
- An Add-feature PLAN with a new agent capability requires safety reasoning.

## Adversarial stance

The reviewer's starting assumption is that the artifact is wrong or incomplete.
Evidence must defeat that assumption, not paper over it. Specific failure modes
to probe:

- **Coverage without substance.** `ut-tdd doctor` green and `ut-tdd vmodel lint`
  passing do not mean design content is correct. Read each design doc to verify
  the claim it makes is actually substantiated in the body.
- **Gate evasion.** Check that every `// biome-ignore` and `// @ts-ignore` has a
  PLAN-linked rationale. Unexplained suppressions fail the review.
- **Trace completeness.** Every FR mentioned in the PLAN's `review_evidence`
  field should map to a real design doc or test assertion, not just an ID string.
- **Absent layer artifacts.** If an L6 test-design doc is missing for a new
  function, note it as an open obligation even if L7 code exists.
- **Handover freshness.** If the session crosses a runtime boundary, verify
  `.ut-tdd/handover/CURRENT.json` is present, non-stale, and the carry list
  matches `ut-tdd status` output.

## Review procedure by gate

**G2 (pair-freeze — design ready for implementation):**
1. `ut-tdd plan lint` exits 0.
2. `ut-tdd doctor` exits 0.
3. Read the design doc body — not just the header table.
4. Confirm the design is at the stated layer's expected granularity (L5 = unit
   test boundary, not L3 feature-level prose).
5. Record finding in PLAN `review_evidence` with reviewer identity and outcome.

**G4/G5 (trace-freeze — implementation complete):**
1. `npm run typecheck`, `npm run lint`, `npm run test` all exit 0 on HEAD.
2. `ut-tdd doctor` exits 0.
3. Confirm no `.skip` or `todo` in Vitest scope without PLAN rationale.
4. Spot-check three test assertions: do they exercise the specified behaviour or
   only verify the happy path?
5. Record finding.

**G6/G7 (accept — final acceptance):**
1. `ut-tdd review --uncommitted` no blocking findings.
2. All G4/G5 conditions still green.
3. ADR set to `Accepted` where applicable.
4. Handover updated or closed.

## Structured attack/defense protocol (counterexample construction, not voting)

This protocol supplements the gate-by-gate procedure above with a stricter,
role-separated form of adversarial review for high-risk artifacts (e.g. a
risk-weighted sample flagged for deeper scrutiny). It is not a vote or a
consensus check: a structural gate being green (`ut-tdd doctor`, `vmodel
lint`) shows the artifact is "not broken," not that it is high quality. The
adversarial structure asks a narrower, falsifiable question instead —
**does an unrefuted attack exist?** — and is a filter that reduces how much a
human needs to look at directly; it does not replace human spot-check review.

**Roles are separated and blind.** The attacker receives only the review
packet — no conversation history, no repository, no authoring context. The
defender receives the packet plus the attacker's recorded attack log, and
nothing else. The artifact's author model/session may serve as **neither**
attacker nor defender.

**The attacker's duty is constructing a concrete counterexample**, not
casting an opinion. Only four attack types are valid:

1. Two readings of the same requirement/spec text that produce different
   pass/fail outcomes.
2. A concrete input, state, or ordering that the declared tests do not cover.
3. Evidence from which a re-verification procedure cannot be reconstructed
   (the trail is present but unusable to redo the check).
4. A scenario where the declared tests are green but the actual requirement
   is not met.

"Seems ambiguous" or "looks insufficient" is not an attack — the attacker
must write the counterexample itself (the specific reading split, the
specific uncovered input, the specific unreconstructable step, or the
specific green-but-unmet scenario). If no attack can be constructed, the
attacker declares `no_attack` and must log at least 3 attempted attacks and
why each failed to hold; a `no_attack` with fewer than 3 logged attempts is
invalid and is treated as **OPEN**, not as evidence of safety.

**The defender's duty is refutation by citation only.** A refutation is valid
only in the form "that counterexample is excluded by the text '…'" — quoting
the packet. Appeals to common sense, inferred intent, or context outside the
packet are not refutations. If no quote excludes the counterexample, the
defender leaves the refutation blank; conceding is the correct verdict in
that case, not a defender failure.

**Verdicts:**

- **One or more attacks left unrefuted → FLAG.** Route to correction. Editing
  or deleting a recorded attack to make it disappear is tampering and is
  prohibited — the record is append-only.
- **All logged attacks refuted by citation → PASS**, with the attack/defense
  record attached. A subset of PASS verdicts still goes to human spot-check
  (the third defense layer is never fully replaced).
- **`no_attack` (with >=3 logged attempts) → PASS-WEAK.** This is the
  **priority** target for human spot-check, not a stronger result than a
  contested-and-refuted PASS — "no attack was found" is not proof the
  artifact is safe, only that this attacker did not find one.

**Known limits of this protocol itself:** attackers and defenders are
themselves subject to Goodhart pressure (a lazy attacker discharges duty with
a weak attack; a defender may over-reach a refutation). This is why the
protocol requires a verifiable artifact at each step — a literal
counterexample from the attacker, a literal quote from the defender — rather
than a prose judgement call, and why it never replaces the human spot-check
tier. Models from the same family also have correlated blind spots, so a
PASS from this protocol means only "survived this attacker," not a general
safety or correctness guarantee.

## Evidence format

Record adversarial review evidence in the PLAN's `review_evidence` field:

```
reviewer: <agent-slug or "intra_runtime_subagent">
gate: G5
outcome: PASS | FAIL | CONDITIONAL
findings:
  - <specific finding or "none">
timestamp: <ISO-8601>
```

A gate with no recorded evidence is not cleared, regardless of `ut-tdd doctor`
status.

## Anti-patterns

- Treating `ut-tdd doctor` green as the only required check — doctor sees
  structure, not substance.
- Running review on a partial diff — always review the full PLAN scope.
- Self-review as the only review evidence in hybrid mode — hybrid mode requires
  a different runtime or subagent family.
