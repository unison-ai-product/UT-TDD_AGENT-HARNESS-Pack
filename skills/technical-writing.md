---
schema_version: skill.v1
name: technical-writing
skill_type: domain-writing
category: domain
domain_tags:
  - writing
  - documentation
  - technical-writing
  - editing
triggers: writing quality, clarity, prose editing, plain-language rewriting, doc readability
decision_points:
  - when: "writing instructions or describing current behavior"
    choose: "active voice, present tense"
    over: "passive voice or past-tense narration"
    because: "passive constructions hide who does what and blur whether the behavior is current"
  - when: "explaining a technical decision, error, or trade-off"
    choose: "state the answer or recommendation in the first sentence"
    over: "building up through background before the point"
    because: "a reader must be able to state the main point after only the first sentence"
  - when: "the audience is a domain expert who already knows the term"
    choose: "skip the definition and use the term directly"
    over: "defining it on first use as if for a novice"
    because: "over-explaining to an expert buries the actionable content under redundant background"
  - when: "the same entity is referenced more than once in a document"
    choose: "one consistent name for that entity throughout"
    over: "varying the name for stylistic variety (e.g. \"user\" vs \"account\")"
    because: "synonym variety makes one concept read as two distinct entities"
  - when: "describing what changed in a system"
    choose: "name the specific file, command, or number"
    over: "generic phrasing like \"various improvements\""
    because: "concrete references are verifiable; abstract summaries are not"
---

# technical writing

A **domain skill** (not a workflow skill): it is indexed by `category` + `domain_tags`
(skill-index.md §1), not by a V-model layer or drive model. Load it whenever the task
is to write or improve prose for clarity — a README, a runbook, release notes, an issue
summary, or any natural-language artifact — regardless of which workflow or layer you are in.

This is intentionally distinct from the workflow skills `documentation-and-adrs`
(authoring V-model design docs / ADRs at design layers under Forward) and `documentation`
(maintaining repository prose). Those bind to layers/drives; this one is transferable
writing-quality knowledge pulled by situation.

## When to load this skill

- The task is to write or rewrite prose for a human reader (not code, not a schema).
- Existing text is unclear, bloated, or burying its point, and needs editing.
- You must explain a technical decision, error, or trade-off in plain language.

## Core moves

- **Lead with the conclusion.** State the answer or recommendation first; supporting
  detail follows. Do not make the reader assemble the point from clues.
- **One idea per sentence; one topic per paragraph.** Split run-ons. Cut sentences that
  restate the previous one.
- **Prefer concrete to abstract.** Name the file, the command, the number. Replace
  "various improvements" with what changed.
- **Cut hedging and filler.** Remove "basically", "in order to", "it should be noted
  that". Strong claims need evidence, not qualifiers.
- **Active voice, present tense** for instructions and current behavior.
- **Match the reader.** Define a term on first use only if the reader will not know it;
  do not over-explain to an expert audience.

## Anti-patterns

- A wall of text with no headings or lead sentence.
- Passive constructions that hide who does what ("mistakes were made").
- Synonyms-for-variety that make the same concept look like two ("user" vs "account"
  used interchangeably for one entity).
- Burying the actionable instruction under background.

## Done check

- A reader can state the main point after reading only the first sentence/paragraph.
- Every sentence earns its place; deleting it would lose information.
- No mojibake, no broken links, headings reflect structure.
