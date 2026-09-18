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
decision_points:
  - when: "A URL was found via WebSearch and is a candidate citation"
    choose: "WebFetch the body and confirm the claim actually appears before citing it"
    over: "Citing the URL directly from the WebSearch snippet"
    because: "The snippet can misrepresent the source; only the fetched body confirms publication date, version scope, and the actual claim"
  - when: "A version or compatibility constraint needs to be asserted"
    choose: "Confirm it from a WebFetch-verified primary source"
    over: "Asserting it from a search snippet alone"
    because: "This is explicitly prohibited: snippet-only version claims are unverified and can be stale or out of scope"
  - when: "Selecting which source to use as decision evidence in an ADR or PLAN"
    choose: "Use a primary source (vendor docs, standard spec, official repo) as the citation of record"
    over: "Using a secondary source (aggregation/repost/summary) as the sole citation"
    because: "Secondary sources lack original methodology and must not be a sole citation in an ADR or PLAN"
  - when: "A previously cited URL now 404s or redirects"
    choose: "Re-fetch it and re-confirm the claim before continuing to cite it"
    over: "Keeping the old citation because it was valid at an earlier point"
    because: "Content behind a URL can change; an unconfirmed stale citation is unverifiable evidence"
  - when: "A multi-source research sweep is delegated to pmo-haiku"
    choose: "Verify at least one returned source yourself before recording it as authoritative"
    over: "Recording the delegated output directly as authoritative research"
    because: "Delegated output is a claim, not evidence, until independently checked"
  - when: "Recording a research finding"
    choose: "Always include the retrieval date"
    over: "Omitting the retrieval date when the claim itself seems stable"
    because: "Without a retrieval date, staleness of the finding cannot be judged later"
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
