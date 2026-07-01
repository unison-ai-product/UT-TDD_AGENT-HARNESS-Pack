---
schema_version: skill.v1
name: research
skill_type: process
applies_to:
  layers:
    - L1
    - L2
    - L3
  drive_models:
    - Discovery
    - Scrum
    - Forward
    - Add-feature
---

# research

WebSearch/WebFetch primary-source protocol for UT-TDD (FR-L1-27 Research
workflow → ADR; supports the elicitation-AI-first rule: web research + subagent
self-review before asking the PO). Two rules: no assertion without a
primary-source URL, and no URL cited without a WebFetch body confirmation.

## When to load this skill

- A Discovery PLAN (S1 plan / S2 PoC) needs external technology comparison.
- An ADR's Context section cites external evidence.
- A task routes to a `pmo-tech-docs` / `pmo-tech-news` subagent.
- A PLAN depends on an external API, library, or standard that must be confirmed
  before pair-freeze.

## Two-tool protocol

**Step 1 — WebSearch (collect candidates).** Query with subject + constraint
(version, deprecation, release notes), official-domain identifiers, and a year
qualifier. Discard non-primary-domain snippets as decision evidence.

**Step 2 — WebFetch (confirm bodies).** For every URL that will be cited, fetch
it and confirm: publication date / version scope, that the specific claim
actually appears in the body, and any compatibility or deprecation caveats.
Never cite a URL seen only as a search snippet — the snippet can misrepresent the
source.

## Source reliability labels

| Label | Definition |
|---|---|
| primary | Vendor official docs, standard spec, official source repo |
| first-hand | Investigation article with methodology shown |
| secondary | Aggregation / repost / summary without original methodology |

Decision evidence must be `primary`; `first-hand` may supplement; `secondary` is
background only and must not be a sole citation in an ADR or PLAN.

## Output format (recorded in a PLAN / ADR / `.ut-tdd/audit/`)

```
Research summary: [2-5 sentences]
Sources:
1. [Title](URL) — primary — retrieved YYYY-MM-DD — vX.Y / date-scoped
   Key claim: ...   WebFetch confirmed: yes
Unresolved / requires-further-investigation:
- [specific gap]
```

## Integration with Discovery / Scrum

- Discovery S1: findings feed the PLAN `evidence` before `ut-tdd plan lint`.
- Scrum S2: the chosen technology cites at least one `primary` source.
- Scrum S3: a PoC result that contradicts prior research is recorded in
  `.ut-tdd/audit/` before S4 decide.

## Cost-aware delegation

For multi-source sweeps, delegate to the lightweight research role via
`ut-tdd claude --role pmo-haiku --task "..."` (inspect the prompt first with
`--dry-run`). Require: objective, minimum 2 primary sources, the output format
above, and WebFetch confirmation per URL. Verify at least one returned source
yourself before recording it as authoritative — delegated output is a claim, not
evidence.

## Prohibited

- Asserting a version constraint from a search snippet alone.
- Citing a URL that 404s or redirects without re-fetching.
- A `secondary` source as the sole citation for an ADR decision.
- Research findings recorded without a retrieval date (staleness cannot be
  judged).
