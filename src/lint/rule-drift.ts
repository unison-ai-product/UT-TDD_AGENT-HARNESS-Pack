import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleAdapterDocs {
  agents: string;
  claudeProject: string;
  claudeRuntime: string;
}

export interface RuleDriftResult {
  forbiddenMarkers: { file: string; marker: string }[];
  missingMarkers: { file: string; marker: string }[];
  ok: boolean;
}

const SHARED_MARKERS = [
  "ut-tdd status",
  "ut-tdd doctor",
  "ut-tdd handover",
  "ut-tdd codex --role <role> --task",
  "ut-tdd claude --role <role> --task",
  "ut-tdd team run --definition .ut-tdd/teams/<team>.yaml",
  "standalone",
  "claude-only",
  "codex-only",
  "hybrid",
] as const;

const ADAPTER_MARKERS = {
  "AGENTS.md": ["CLAUDE.md", ".claude/CLAUDE.md"],
  "CLAUDE.md": [".claude/CLAUDE.md", "AGENTS.md"],
  ".claude/CLAUDE.md": ["../CLAUDE.md", "../AGENTS.md"],
} as const;

const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_RUNTIME_ENV_PREFIX = LEGACY_RUNTIME_NAME.toUpperCase();
const FORBIDDEN_ADAPTER_MARKERS = [
  {
    marker: "legacy runtime command routing",
    pattern: new RegExp(
      String.raw`\b${LEGACY_RUNTIME_NAME}\s+(codex|claude|plan|gate|handover)\b`,
      "i",
    ),
  },
  {
    marker: "legacy runtime env prefix",
    pattern: new RegExp(String.raw`\b${LEGACY_RUNTIME_ENV_PREFIX}_`),
  },
  {
    marker: "legacy runtime local state path",
    pattern: new RegExp(String.raw`\.${LEGACY_RUNTIME_NAME}(?:/|\\)`, "i"),
  },
  {
    marker: "legacy runtime agent name",
    pattern: new RegExp(String.raw`\bpmo-${LEGACY_RUNTIME_NAME}-`, "i"),
  },
] as const;

export function analyzeRuleDrift(docs: RuleAdapterDocs): RuleDriftResult {
  const files = {
    "AGENTS.md": docs.agents,
    "CLAUDE.md": docs.claudeProject,
    ".claude/CLAUDE.md": docs.claudeRuntime,
  };
  const forbiddenMarkers: { file: string; marker: string }[] = [];
  const missingMarkers: { file: string; marker: string }[] = [];

  for (const marker of SHARED_MARKERS) {
    for (const [file, text] of Object.entries(files)) {
      if (!text.includes(marker)) missingMarkers.push({ file, marker });
    }
  }
  for (const [file, markers] of Object.entries(ADAPTER_MARKERS)) {
    const text = files[file as keyof typeof files];
    for (const marker of markers) {
      if (!text.includes(marker)) missingMarkers.push({ file, marker });
    }
  }
  for (const [file, text] of Object.entries(files)) {
    for (const marker of FORBIDDEN_ADAPTER_MARKERS) {
      if (marker.pattern.test(text)) forbiddenMarkers.push({ file, marker: marker.marker });
    }
  }

  return {
    forbiddenMarkers,
    missingMarkers,
    ok: missingMarkers.length === 0 && forbiddenMarkers.length === 0,
  };
}

export function loadRuleAdapterDocs(repoRoot: string): RuleAdapterDocs {
  const read = (path: string) => {
    const full = join(repoRoot, path);
    if (!existsSync(full)) throw new Error(`missing rule adapter doc: ${path}`);
    return readFileSync(full, "utf8");
  };
  return {
    agents: read("AGENTS.md"),
    claudeProject: read("CLAUDE.md"),
    claudeRuntime: read(join(".claude", "CLAUDE.md")),
  };
}

export function ruleDriftMessages(result: RuleDriftResult): string[] {
  if (result.ok) {
    return ["rule-drift - OK (AGENTS/CLAUDE adapters share required mode and command markers)"];
  }
  if (result.forbiddenMarkers.length > 0) {
    const sample = result.forbiddenMarkers
      .slice(0, 8)
      .map((m) => `${m.file}:${m.marker}`)
      .join(", ");
    return [
      `rule-drift - violation: forbidden adapter legacy marker ${result.forbiddenMarkers.length} (${sample})`,
    ];
  }
  const sample = result.missingMarkers
    .slice(0, 8)
    .map((m) => `${m.file}:${m.marker}`)
    .join(", ");
  return [
    `rule-drift - violation: adapter rule marker drift ${result.missingMarkers.length} (${sample})`,
  ];
}
