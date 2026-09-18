---
schema_version: skill.v1
name: design-family-ai-agent
skill_type: design-contract
applies_to:
  layers:
    - L4
    - L5
    - L10
  drive_models:
    - Forward
    - Add-feature
    - Discovery
decision_points:
  - when: "Documenting an agent's tool inventory (the AI agent design doc's tool/function chapter)."
    choose: "a per-tool table with name, input/output schema, and an explicit permission boundary (scope such as `tasks:write`, side-effect class, and whether HITL is required before execution)"
    over: "listing tool names with input/output shape only and leaving permission/side-effect scope implicit"
    because: "a tool without a stated permission boundary cannot be reviewed for over-privilege; the permission column is what lets a reviewer catch a write-scoped tool wired to a read-only use case before it ships."
  - when: "Changing a system prompt, tool description, or few-shot example used by a production agent."
    choose: "treat the prompt as a versioned artifact (template + version number) and require an eval run before the change is promoted"
    over: "editing the prompt text in place with no version tracking and shipping on visual inspection alone"
    because: "unversioned prompt edits are unauditable — when agent behaviour regresses, there is no way to correlate the regression to the specific prompt change without a version history and a paired eval result."
  - when: "Defining when an agent must stop and ask a human (Human-in-the-Loop) rather than act autonomously."
    choose: "enumerate explicit escalation triggers (destructive/irreversible action, confidence below a stated threshold, ambiguous instruction) and record who approves and how the approval is audited"
    over: "documenting HITL as a general principle ('a human reviews important actions') with no trigger list or approver record"
    because: "an undefined trigger list means every engineer implements a different threshold for 'important,' and an unaudited approval means no one can later reconstruct who authorized an action that turned out to be wrong."
  - when: "Sizing an agent's operational budget (design doc's guardrails/resource chapter)."
    choose: "state a concrete step-count limit, timeout, and per-run cost ceiling"
    over: "leaving resource bounds unstated and relying on the model's own judgement to stop"
    because: "an unbounded agent loop is both a cost-runaway risk and a correctness risk (a stuck ReAct loop retries a failing tool call indefinitely); a stated ceiling makes the failure mode a bounded, testable one instead of an open-ended incident."
  - when: "Designing the verification process for AI-generated output (code, design docs, user-facing text, classifications)."
    choose: "implement all three layers — structural gate (schema/lint/test pass), adversarial substance verification (an independent attacker/defender pass that must find zero unrebutted counterexamples), and human spot-check on a sampled fraction of PASS results"
    over: "collapsing verification to structural gate plus human review, treating a green structural gate as evidence of quality"
    because: "a green structural gate proves the artifact is not broken, not that it is correct (Goodhart's law applies directly — an artifact can satisfy every schema/lint/test check while being formally complete and substantively hollow); skipping the adversarial layer removes the only step designed to catch that specific failure mode."
  - when: "Deciding which AI-output verification decisions can be delegated to automation versus which must stay with a human reviewer."
    choose: "record the delegate-vs-human boundary explicitly as an ADR (which artifact types get automation-only sign-off, which require human sign-off, and why)"
    over: "leaving the boundary as an informal team norm that shifts silently as automation coverage grows"
    because: "an undocumented boundary drifts — each new automation feature quietly expands its own authority unless a written boundary forces an explicit decision to expand it, and the ADR is the reviewable artifact that shows the decision was made deliberately."
  - when: "Swapping the underlying model or bumping its version for a production agent (model governance / ML-BOM chapter)."
    choose: "require a re-run of the golden-set regression eval (accuracy, hallucination rate, safety-eval score) before the swap is rolled out, and record the eval result in the ML-BOM"
    over: "trusting the vendor's release notes or informal spot-checking as sufficient evidence the swap is safe"
    because: "model behaviour shifts between versions are not fully predictable from release notes alone; the eval is the only mechanism that actually measures whether accuracy, hallucination, or safety regressed for this product's specific task distribution."
  - when: "The product contains any AI-generated artifact that reaches the product surface (generated code merged to main, an AI-authored design section, user-facing generated text, an AI classification decision) — including at PoC/S2 scale."
    choose: "adopt the AI-output-verification design (structural gate + adversarial verification + human spot-check) as mandatory even at PoC scale"
    over: "deferring verification design until the product 'scales up' past the PoC stage"
    because: "unverified AI output is the highest-variance input class the product can ingest — a PoC that ships even one unverified AI-generated artifact to a real user carries the same defect class as production; the source profile explicitly keeps ai_verification adopted even at PoC scale for this reason, and scale is not a mitigating factor for variance."
---

# design family: AI agent

This is a **family skill**: it defines what the AI-agent-related design
documents must contain, not how to implement a specific agent's reasoning
loop or which model/effort tier to route a call to (those are owned by
[[agent-design]] and [[llm-agent-routing]] — see Boundary below). Load this
skill when authoring or reviewing the design-doc set that governs a
*product's* AI agent feature: the agent architecture itself, the
verification pipeline for its output, and the governance of the underlying
models.

## When to load this skill

- Authoring or reviewing an AI agent design doc (architecture, tools,
  memory/RAG, guardrails, HITL, eval).
- Authoring or reviewing an AI-output verification design doc for any
  AI-generated artifact (code, design docs, generated text, classifications).
- Authoring or reviewing a model governance / ML-BOM design doc.
- A PLAN adds a new agent tool, a new AI-generated artifact type reaching
  users, or swaps/upgrades the underlying model.
- Deciding whether AI-output verification is in scope for a PoC-stage
  product slice.

## Document set and role

| # | Document | Role |
|---|---|---|
| 40 | AI agent design | Defines the agent's architecture (planner/executor, tools, memory/RAG, guardrails, HITL), reasoning pattern, tool contracts with permission boundaries, and prompt version management. |
| 49 | AI-output verification design | Defines the multi-layer verification pipeline every AI-generated artifact must pass before acceptance, the per-artifact-type acceptance criteria, and the delegate-vs-human boundary. |
| 70 | Model governance / ML-BOM | Defines the provenance record (model identity, version, data lineage, license) for every model in use, the model card, and the eval-before-swap gate. |

## MUST-contain items per document

**40 AI agent design**
- Prompts (system prompt, tool descriptions, few-shot examples) declared as
  versioned artifacts with a stated eval-before-promote gate, not edited
  in-place.
- A tool inventory table: tool name, input/output schema, and a **permission
  boundary per tool** (RBAC/tenant scope, side-effect class, HITL
  requirement) — not tool names alone.
- Explicit escalation/HITL rules: which action classes require human
  approval, the confidence threshold that triggers a confirmation prompt,
  and the audit record of who approved what.
- A resource/cost budget: step-count limit, timeout, and per-run cost
  ceiling — stated as concrete bounds, not left to model judgement.
- Memory/RAG isolation: tenant-scoped retrieval filtering and a staleness/
  provenance tag on retrieved content.

**49 AI-output verification design**
- The three-layer defense stated explicitly and kept distinct:
  1. **Structural gate** — automated schema/lint/test/type/trace checks run
     on every change; catches broken references and contract violations.
  2. **Adversarial substance verification** — an independent
     attacker-constructs-counterexample /
     defender-rebuts-with-citation pass; a single unrebutted counterexample
     flags the artifact. This layer is what catches an artifact that is
     structurally complete but substantively hollow (Goodhart's law: a
     green structural gate is "not broken," not "correct").
  3. **Human spot-check** — a sampled fraction (commonly ~10%) of
     structural+adversarial PASS results is manually verified against the
     original source; this layer catches defects the adversarial layer
     itself misses (including its own degradation over time).
- Per-artifact-type acceptance criteria (code: tests/coverage/SCA/SAST +
  human readability review; design docs: validate/consistency-check +
  human content-validity review; generated text: fact/citation check +
  human tone/accuracy review; data/classification: schema validation +
  human representativeness/bias check).
- An explicit **delegate vs. keep-human** boundary recorded as an ADR: which
  verification decisions automation may finalize alone, and which require a
  human sign-off before acceptance.
- Golden-set eval thresholds (accuracy, hallucination rate, safety-eval
  score) with a stated re-evaluation trigger (model or prompt change).
- Grounding/citation verification for any RAG-sourced output: source
  currency and relevance checked against the original, not merely present.
- An audit trail recording verification input/output, decision, and
  approver for every accepted or rejected artifact.
- Operating rules for the adversarial layer: a PASS must not be reported as
  "quality-assured" (report it as "structural integrity maintained and
  survived adversarial verification"); a FLAG cannot be edited or deleted
  without remediation; "no successful attack" is PASS-WEAK, not proof of
  safety, and is a priority target for the human spot-check layer;
  attacker/defender sessions are blind (no build history) and run on
  separate sessions/providers from whichever model produced the artifact.

**70 Model governance / ML-BOM**
- Model identity record: name, version, provider, and a content hash or
  equivalent integrity marker — not a bare model name.
- Dependency inventory: inference libraries/runtime, MCP servers or tool
  servers the model depends on.
- Data provenance: training/fine-tuning data origin, and license terms for
  both model and data.
- A model card: intended use / explicit non-use cases, known
  limitations/biases, and the safety mitigation (HITL trigger) tied to each
  known limitation.
- An **eval-before-swap gate**: any model or version change requires a
  golden-set regression eval pass before rollout, with the result recorded
  in the ML-BOM (links to 49's eval thresholds).

## Characteristic omissions (what weak docs in this family typically miss)

- **40**: tools listed with input/output schema but no permission-boundary
  column, so a reviewer cannot tell which tools are destructive or
  cross-tenant without reading implementation code; prompts edited without
  a version number, so a behaviour regression cannot be traced to its cause.
- **49**: verification collapsed to two layers (structural gate + human
  review), silently dropping the adversarial substance layer — this is the
  single most common gap, because structural-gate-plus-human-review *looks*
  complete but has no mechanism for catching an artifact that is
  formally correct and substantively wrong; also, "no successful attack"
  reported as a pass rather than as PASS-WEAK requiring spot-check priority.
- **70**: model swapped on vendor release notes alone with no re-run of the
  golden-set eval recorded, so an accuracy/hallucination/safety regression
  ships undetected until a user reports it in production.

## Boundary

This family skill defines **what** the AI-agent design documents must
contain as chapters and MUST-have items for a *product's own* AI agent
feature. It does not define:

- **How** to implement the agent's internal reasoning loop, tool-calling
  mechanics, or the harness's own subagent guard configuration — that is
  [[agent-design]] (note: [[agent-design]]'s decision points are about the
  UT-TDD harness's own `.claude/agents/*` subagent definitions and guard
  allowlist, a different concern from a product feature's AI agent design).
- **Which** model/effort tier to route a call to, or how to wire a PLAN's
  `agent_slots` through `ut-tdd claude`/`ut-tdd codex` wrappers — that is
  [[llm-agent-routing]].
- **How** to run an adversarial review pass mechanically (attacker/defender
  protocol, packet construction, blinding rules) for any UT-TDD review gate
  in general — that is [[adversarial-review]]; document 49's Chapter 9
  three-layer defense is a specific application of that same protocol to
  AI-generated *product* artifacts, and the MUST-contain items above state
  what the design doc must record about that application, not the generic
  protocol mechanics themselves.

If a PLAN is adding or reviewing one of the three documents above for a
product's AI feature, load this skill. If a PLAN is defining a new UT-TDD
harness subagent or routing a delegation call, load the harness-side skills
instead.

## Product-pattern conditioning

- **No AI feature in the product at all**: this document set (40/49/70) is
  out of scope; do not author it speculatively ahead of an actual AI
  feature decision.
- **Any AI-generated artifact reaches the product surface, even at PoC
  scale**: document 49 (AI-output verification) is mandatory, not deferred
  to a later scale-up milestone — unverified AI output is the
  highest-variance input the product can ingest, and a PoC user is exposed
  to the same defect class as a production user.
- **The AI feature only calls models through a vendor API with no
  fine-tuning or custom training data**: document 70's data-provenance
  section may be scoped to "vendor-managed, not applicable" explicitly
  (state the scope decision) rather than fabricating a training-data
  lineage that does not exist — but the model-identity, eval-before-swap,
  and model-card sections remain mandatory regardless of who trained the
  model.
