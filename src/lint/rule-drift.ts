import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleAdapterDocs {
  agents: string;
  claudeProject: string;
  claudeRuntime: string;
  /** AI が直接読む instruction surface。adapter 間の必須 marker とは分離して検査する。 */
  instructionSurfaces?: Readonly<Record<string, string>>;
}

export interface RuleDriftResult {
  forbiddenMarkers: { file: string; marker: string }[];
  missingMarkers: { file: string; marker: string }[];
  ok: boolean;
}

export interface DocumentedHookCommand {
  event: string;
  command: string;
}

export interface HookParityResult {
  documentedOnly: DocumentedHookCommand[];
  configuredOnly: DocumentedHookCommand[];
  ok: boolean;
  parseError: string | null;
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
  // PLAN filing discipline lived only in .claude/CLAUDE.md until 2026-07-28, so the
  // Codex adapter never received it (route_signal / generates / plan_id: 0 hits in
  // AGENTS.md, measured). Filing rules are shared workflow, and an adapter that
  // silently drops them produces PLANs that trip the governance gates on push.
  "route_signal",
  "generates",
] as const;

const ADAPTER_MARKERS = {
  "AGENTS.md": ["CLAUDE.md", ".claude/CLAUDE.md"],
  "CLAUDE.md": [".claude/CLAUDE.md", "AGENTS.md"],
  ".claude/CLAUDE.md": ["../CLAUDE.md", "../AGENTS.md"],
} as const;

const LEGACY_RUNTIME_NAME = ["he", "lix"].join("");
const LEGACY_RUNTIME_ENV_PREFIX = LEGACY_RUNTIME_NAME.toUpperCase();

function normalizeBunToken(token: string): string {
  return token
    .trim()
    .replace(/^[`'"[(|]*/, "")
    .replace(/[`'"\])|]*$/, "")
    .trim();
}

function isBunExecutionArgument(token: string): boolean {
  if (!token) return false;
  const trimmed = normalizeBunToken(token);
  if (!trimmed) return false;
  if (/^(?:-[^\s`"]+|--[^\s`"]+)$/.test(trimmed)) return true;
  if (/^(?:run|test|install|build|status)$/.test(trimmed)) return true;
  if (/^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(trimmed)) return true;
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(trimmed)) return true;
  if (/^(?:src|scripts|node_modules)\//i.test(trimmed)) return true;
  if (/^(?:src|scripts|node_modules)[\\/]/i.test(trimmed)) return true;
  if (/^[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md)$/.test(trimmed)) return true;
  if (/[\\/]/.test(trimmed)) return true;
  return false;
}

function containsBunExecutionInstruction(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const contents = match[1].trim();
      const [token] = contents.split(/\s+/);
      if (token && /^bunx?$/i.test(token)) return true;
      if (/^bun\.(?:cmd|exe)$/i.test(token)) return true;
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const token = normalizeBunToken(tokens[i]);
      if (!token) continue;
      const lower = token.toLowerCase();
      if (lower === "bunx") {
        if (tokens[i + 1]) return true;
        continue;
      }
      if (lower === "bun") {
        if (isBunExecutionArgument(tokens[i + 1])) return true;
        continue;
      }
      if (/^bun\.(?:cmd|exe)$/i.test(lower)) return true;
    }
  }

  return false;
}

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
  // Bun は #134 (PO 決定 2026-07-22) で permanent ban、package.json も
  // bunAuthority: legacy_migration_debt を宣言している。それでも adapter doc の Hooks 節は
  // `bun "$CLAUDE_PROJECT_DIR/..."` を指示したままで、.claude/settings.json (全 hook が node)
  // と正面から矛盾していた。指示に従った実行が廃止ランタイム固有の失敗を生み、存在しない
  // 欠陥の修理 issue #321 が起票された (2026-08-14)。marker 節しか見ない既存の drift 検査は
  // これを素通ししたので、実行指示としての Bun 起動形を forbidden marker に加える。
  // 過去 incident の記述 (「bun runaway ×2」等) は実行指示ではないので巻き込まない。
  {
    marker: "bun execution form",
    // 実行指示だけを拾い、散文は拾わない。判別は次の 3 形に限る:
    //   (a) `bun` / `bunx` を丸ごと code span にした形 (`` `bun run x` `` 等)
    //   (b) bun/bunx の直後に引数らしき token (flag / 引用符 / path / 変数 / *.ts) が続く形
    //   (c) bun.cmd / bun.exe (実行ファイル名そのもので、散文には現れない)
    // 「bare bun + 空白」を実行形と見なすと `use bun runtime` や `bun runaway ×2` まで
    // forbidden になり U-RDRIFT-006 と自己矛盾するため、その条件は採らない
    // (cross-review 2026-08-14 blocking 2 の是正)。
    pattern: /$^/,
  },
] as const;

/** `.claude/CLAUDE.md` の Hooks 行に書かれた hook 起動形を (event, command) で取り出す。 */
export function parseDocumentedHookCommands(claudeRuntimeDoc: string): DocumentedHookCommand[] {
  const commands: DocumentedHookCommand[] = [];
  for (const line of claudeRuntimeDoc.split(/\r?\n/)) {
    const match = /^- `([^`]+)`:\s*`([^`]+)`\s*$/.exec(line.trim());
    if (!match) continue;
    const [, event, command] = match;
    if (
      !/^(?:PreToolUse|PostToolUse|SessionStart|Stop|SubagentStop|SessionEnd|Notification)\b/.test(
        event,
      )
    ) {
      continue;
    }
    commands.push({ event, command });
  }
  return commands;
}

/** `.claude/settings.json` の hook 定義を doc と同じ `command "arg" ...` 形へ正規化する。 */
export function parseConfiguredHookCommands(settingsJson: string): DocumentedHookCommand[] {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: Record<string, { matcher?: string; hooks?: { command?: string; args?: string[] }[] }[]>;
  };
  const commands: DocumentedHookCommand[] = [];
  for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
    for (const group of groups ?? []) {
      const label = group.matcher ? `${event}(${group.matcher})` : event;
      for (const hook of group.hooks ?? []) {
        if (!hook.command) continue;
        const args = (hook.args ?? []).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
        commands.push({ event: label, command: [hook.command, ...args].join(" ") });
      }
    }
  }
  return commands;
}

/**
 * doc の Hooks 節と settings.json の実体が (event, command) 集合として一致するかを見る。
 * 文字列 marker の禁止だけでは「node と書いてあるが引数や event が実体と違う」drift を拾えない
 * ため、実体との等価性そのものを検査対象にする (Issue #322 AC)。
 */
export function analyzeHookParity(input: {
  claudeRuntimeDoc: string;
  settingsJson: string;
}): HookParityResult {
  const key = (entry: DocumentedHookCommand) => `${entry.event}\t${entry.command}`;
  let configured: DocumentedHookCommand[];
  try {
    configured = parseConfiguredHookCommands(input.settingsJson);
  } catch (error) {
    return {
      documentedOnly: [],
      configuredOnly: [],
      ok: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const documented = parseDocumentedHookCommands(input.claudeRuntimeDoc);
  const documentedKeys = new Set(documented.map(key));
  const configuredKeys = new Set(configured.map(key));
  const documentedOnly = documented.filter((entry) => !configuredKeys.has(key(entry)));
  const configuredOnly = configured.filter((entry) => !documentedKeys.has(key(entry)));
  return {
    documentedOnly,
    configuredOnly,
    ok: documentedOnly.length === 0 && configuredOnly.length === 0 && configured.length > 0,
    parseError: null,
  };
}

export function analyzeRuleDrift(docs: RuleAdapterDocs): RuleDriftResult {
  const adapterFiles = {
    "AGENTS.md": docs.agents,
    "CLAUDE.md": docs.claudeProject,
    ".claude/CLAUDE.md": docs.claudeRuntime,
  };
  const files = { ...adapterFiles, ...(docs.instructionSurfaces ?? {}) };
  const forbiddenMarkers: { file: string; marker: string }[] = [];
  const missingMarkers: { file: string; marker: string }[] = [];

  for (const marker of SHARED_MARKERS) {
    for (const [file, text] of Object.entries(adapterFiles)) {
      if (!text.includes(marker)) missingMarkers.push({ file, marker });
    }
  }
  for (const [file, markers] of Object.entries(ADAPTER_MARKERS)) {
    const text = adapterFiles[file as keyof typeof adapterFiles];
    for (const marker of markers) {
      if (!text.includes(marker)) missingMarkers.push({ file, marker });
    }
  }
  for (const [file, text] of Object.entries(files)) {
    for (const marker of FORBIDDEN_ADAPTER_MARKERS) {
      if (
        marker.pattern.test(text) ||
        (marker.marker === "bun execution form" && containsBunExecutionInstruction(text))
      ) {
        forbiddenMarkers.push({ file, marker: marker.marker });
      }
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
  const commandDirectory = join(repoRoot, ".claude", "commands");
  if (!existsSync(commandDirectory))
    throw new Error("missing instruction surface: .claude/commands");
  const instructionSurfaces: Record<string, string> = {};
  for (const entry of readdirSync(commandDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const relativePath = join(".claude", "commands", entry.name).replaceAll("\\", "/");
    instructionSurfaces[relativePath] = read(relativePath);
  }
  const pullRequestTemplate = ".github/PULL_REQUEST_TEMPLATE.md";
  instructionSurfaces[pullRequestTemplate] = read(pullRequestTemplate);
  return {
    agents: read("AGENTS.md"),
    claudeProject: read("CLAUDE.md"),
    claudeRuntime: read(join(".claude", "CLAUDE.md")),
    instructionSurfaces,
  };
}

export function loadClaudeHookSettings(repoRoot: string): string {
  const full = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(full)) throw new Error("missing claude hook settings: .claude/settings.json");
  return readFileSync(full, "utf8");
}

export function hookParityMessages(result: HookParityResult): string[] {
  if (result.parseError) {
    return [`rule-drift - violation: .claude/settings.json parse failed (${result.parseError})`];
  }
  if (result.ok) return ["rule-drift - OK (.claude/CLAUDE.md Hooks == .claude/settings.json)"];
  const sample = [...result.documentedOnly, ...result.configuredOnly]
    .slice(0, 8)
    .map((entry) => `${entry.event}:${entry.command}`)
    .join(", ");
  return [
    `rule-drift - violation: hook doc/settings drift ${result.documentedOnly.length + result.configuredOnly.length} (${sample})`,
  ];
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
