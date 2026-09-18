# UT-TDD Task Classification And Estimation Prompt

Use this prompt only when the rule-based classifier needs an LLM fallback. The
normal execution path is the TypeScript classifier under `src/task/`.

## Input

```json
{
  "task_text": "...",
  "files": null,
  "lines": null,
  "api_changes": false,
  "db_changes": false,
  "plan_frontmatter": {
    "kind": "...",
    "drive": "..."
  }
}
```

## Classification Rules

Return one `kind`, one `drive`, one `size`, one `complexity`, and one
`capability_class`.

- `kind`: `impl`, `design`, `poc`, `reverse`, `add-design`, `add-impl`,
  `refactor`, `retrofit`, `recovery`, `troubleshoot`, or `research`.
- `drive`: `be`, `fe`, `fullstack`, `db`, or `agent`.
- `size`: `S`, `M`, `L`, or `XL`.
- `complexity`: `low`, `medium`, `high`, or `xhigh`.
- `capability_class`: `frontier-reviewer`, `worker`, or `fast-checker`.

Escalate to `frontier-reviewer` when the task has production impact, security
impact, external API assumptions, high uncertainty, large size, or cross-module
design risk.

## Estimation Rules

Use a simple PERT estimate:

```text
most_likely = low:2h, medium:6h, high:12h, xhigh:24h
optimistic = most_likely * 0.5
pessimistic = most_likely * 2
expected = (optimistic + 4 * most_likely + pessimistic) / 6
buffered = expected * risk_factor
```

Use `risk_factor` from `1.0` to `2.0` based on uncertainty, migration work,
cross-platform work, security, external dependencies, and unclear requirements.

## Output

Return JSON only:

```json
{
  "classification": {
    "kind": "...",
    "drive": "...",
    "size": "S|M|L|XL",
    "complexity": "low|medium|high|xhigh",
    "split_required": false,
    "recommended_path": "...",
    "recommended_gates": ["G6", "G7"],
    "confidence": 0.82,
    "reasons": ["..."]
  },
  "estimate": {
    "optimistic_hours": 3,
    "most_likely_hours": 6,
    "pessimistic_hours": 12,
    "expected_hours": 6.5,
    "risk_factor": 1.4,
    "buffered_hours": 9.1,
    "story_points": 5,
    "risks": ["..."]
  },
  "orchestration": {
    "capability_class": "frontier-reviewer|worker|fast-checker",
    "reasons": ["..."]
  }
}
```

Do not call raw provider CLIs or SDKs from this prompt. UT-TDD wrappers own
runtime dispatch, audit evidence, and handover state.
