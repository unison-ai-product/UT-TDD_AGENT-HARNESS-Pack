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
- At least one criterion must be a UT-TDD operational constraint: Windows/Bun
  compatibility, hook integration, `bun run test` / Biome compatibility.

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
