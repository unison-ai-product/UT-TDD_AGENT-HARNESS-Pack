---
schema_version: skill.v1
name: tech-selection
skill_type: design-contract
applies_to:
  layers:
    - L1
    - L3
    - L4
  drive_models:
    - Forward
    - Discovery
    - Scrum
    - Add-feature
decision_points:
  - when: "Evaluating candidate technologies and considering 'popularity' or 'community size' as a criterion."
    choose: "name the specific underlying proxy (maintenance risk, hiring pool, ecosystem maturity) as the criterion instead"
    over: "using 'popularity'/'community' directly as a standalone evaluation criterion"
    because: "the evaluation criteria rules explicitly prohibit these as standalone criteria since they are proxies that hide what is actually being measured, making the comparison table unfalsifiable."
  - when: "A PLAN `requires` an ADR that is still in `Proposed` status."
    choose: "block pair-freeze until the ADR is advanced to `Accepted` with PO confirmation recorded in review_evidence"
    over: "proceeding to L4 design on the assumption the ADR will be accepted eventually"
    because: "the ADR lifecycle table states `Proposed` blocks pair-freeze for any dependent PLAN; proceeding without Accepted status lets unconfirmed technology decisions propagate into committed design."
  - when: "More than five candidate technologies are under consideration for a research-memo."
    choose: "narrow the candidate list to five or fewer before building the comparison table"
    over: "comparing all candidates in the matrix regardless of count"
    because: "the research-memo structure caps candidates at five (minimum two); beyond five the file requires narrowing first, since an unbounded comparison matrix dilutes evidence-gathering per candidate."
  - when: "A new technology decision would supersede an existing accepted ADR."
    choose: "update the old ADR's status to `Superseded` with a link to the new ADR"
    over: "authoring the new ADR without updating the old one's status"
    because: "the pair-freeze checklist explicitly requires no ADR is superseded without a status update and back-link — leaving the old ADR `Accepted` would let two contradictory accepted decisions coexist."
  - when: "A PLAN needs external documentation or comparative research for S2 PoC evidence-gathering."
    choose: "use `ut-tdd claude --role pmo-tech-docs --dry-run` for the retrieval"
    over: "having the orchestrating agent browse and synthesize external docs directly inline"
    because: "the Discovery drive S1-S2 cycle names this delegation path specifically for external documentation retrieval, keeping the research role and evidence trail separate from the orchestrating PLAN work."
---

# tech selection

Technology research, comparative evaluation, and ADR authoring in UT-TDD
(FR-L1-27 research workflow: research-memo + ADR as generates artifacts). Apply
when a PLAN must choose between two or more implementation options before
committing to L4 basic design.

## When to load this skill

- A PLAN with `drive=Discovery` runs Scrum S1-S2 to evaluate competing libraries,
  runtimes, or architectural patterns.
- An L3 functional design exposes a technology choice that must be resolved
  before L4 pair-freeze.
- A new ADR must be authored or an existing ADR must be superseded.
- `ut-tdd skill suggest` returns `tech-selection` for a proposed PLAN.

## Research workflow (FR-L1-27)

The output of a research workflow is exactly two generated artifacts:

1. **research-memo** — a time-bounded comparison document under
   `docs/design/<product>/research/` containing:
   - Problem statement (what decision must be made and by when).
   - Evaluation criteria (each criterion is measurable or falsifiable).
   - Candidates (minimum two; maximum five — beyond five, narrow first).
   - Comparison table: criterion vs. candidate matrix with evidence per cell.
   - Rejected candidates: one-sentence disqualifier each.
   - Recommendation: one candidate with rationale tied to top-ranked criteria.

2. **ADR** — under `docs/adr/ADR-<NNN>-<kebab-slug>.md` containing the decision,
   status (`Proposed` -> `Accepted`), context, and consequences. Reference the
   research-memo by path.

Both must appear in the PLAN's `generates` field. `ut-tdd plan lint` will fail if
`generates` is missing either artifact.

## Evaluation criteria rules

- Criteria must be project-grounded: tie each criterion to an FR, a BR, or a
  pillar from `CLAUDE.md` (foundation-first, type-safety, observability, etc.).
- Do not use "popularity" or "community" as standalone criteria — they are
  proxies; name what they proxy (maintenance risk, hiring, ecosystem maturity).
- At least one criterion must be a UT-TDD operational constraint: Windows/Node
  compatibility, hook integration, `npm run test` / Biome compatibility.

## ADR lifecycle in UT-TDD

| Status | Meaning |
|--------|---------|
| Proposed | Research complete; PO review pending. |
| Accepted | PO confirmed; L4 design may proceed. |
| Superseded | Replaced by a newer ADR (link to successor). |
| Deprecated | Decision no longer applies; record why. |

An ADR in `Proposed` status blocks pair-freeze for any PLAN that `requires` it.
Advance the ADR to `Accepted` (PO confirmation recorded in `review_evidence`)
before pair-freeze.

## Discovery drive: S1-S2 research cycle

- S1 (plan): draft research-memo skeleton in the PLAN doc; list candidates and
  criteria. Use `ut-tdd skill suggest` to confirm no existing ADR already covers
  the decision.
- S2 (PoC): gather evidence per candidate; fill the comparison table. Use
  `ut-tdd claude --role pmo-tech-docs --dry-run` for external documentation
  retrieval when web research is needed.
- S3 (verify): read the filled comparison table; confirm the recommendation is
  tied to project FRs and UT-TDD constraints.
- S4 (decide): PO confirms ADR status `Accepted`; PLAN moves to pair-freeze.

## Pair-freeze checklist for a tech-selection PLAN

- [ ] research-memo exists at `docs/design/.../research/` with all sections
      complete (problem, criteria, candidates, comparison table, recommendation).
- [ ] ADR exists at `docs/adr/` with status `Accepted` and PO confirmation in
      `review_evidence`.
- [ ] Both artifacts listed in PLAN `generates`.
- [ ] `ut-tdd plan lint` exits 0.
- [ ] `ut-tdd doctor` exits 0.
- [ ] No existing ADR is superseded without a `Superseded` status update and a
      link to the new ADR.
