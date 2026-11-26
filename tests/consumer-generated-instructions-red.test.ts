import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSetup, type SetupDeps } from "../src/setup/index.ts";
import { BUILTIN_GITHUB_TEMPLATES, type TemplateSet } from "../src/setup/templates.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const HEAD_SNAPSHOT_ROOT = headSnapshotRoot();
const SOURCE_AGENTS_TEMPLATE = readFileSync(
  join(HEAD_SNAPSHOT_ROOT, "docs", "templates", "adapter", "AGENTS.md"),
  "utf8",
);
const GENERATED_ROOTS: string[] = [];
const DEFAULT_PREFIX = "node .ut-tdd/bin/ut-tdd.mjs";
const ALTERNATE_PREFIX = "node .ut-tdd/bin/consumer-cli-test.mjs";

type Fixture = { name: string; packageJson?: Record<string, unknown> };
type GeneratedFixture = {
  files: Map<string, string>;
  read: (path: string) => string | undefined;
  repoRoot: string;
};

const FIXTURES: Fixture[] = [
  { name: "F1" },
  { name: "F2", packageJson: { scripts: { typecheck: "tsc", lint: "biome", test: "vitest" } } },
  { name: "F3", packageJson: { scripts: {} } },
  { name: "F4", packageJson: { scripts: { typecheck: "tsc" } } },
  { name: "F5", packageJson: { scripts: { test: "vitest" } } },
];

const standardFixtures = new Map<string, GeneratedFixture>();
const substitutedFixtures = new Map<string, GeneratedFixture>();

function generateFixture(fixture: Fixture, templates: TemplateSet): GeneratedFixture {
  const repoRoot = mkdtempSync(join(tmpdir(), `ut-tdd-cgeni-${fixture.name.toLowerCase()}-`));
  GENERATED_ROOTS.push(repoRoot);
  const files = new Map<string, string>();
  if (fixture.packageJson)
    files.set(join(repoRoot, "package.json"), JSON.stringify(fixture.packageJson));

  const deps: SetupDeps = {
    repoRoot,
    now: () => "2026-11-25T00:00:00.000Z",
    gh: () => ({ ok: false, stdout: "" }),
    readText: (path) => files.get(path) ?? null,
    writeText: (path, content) => files.set(path, content),
    confirm: () => true,
    isInteractive: true,
    templates,
  };
  runSetup({ phase: "0-A", dryRun: false, applyBranchProtection: false }, deps);
  const generated = {
    repoRoot,
    files,
    read: (path: string) => files.get(join(repoRoot, path)),
  };
  for (const path of [
    "AGENTS.md",
    "CLAUDE.md",
    join(".claude", "CLAUDE.md"),
    join(".claude", "settings.json"),
    join(".codex", "hooks.json"),
  ]) {
    if (!generated.read(path)) throw new Error(`${fixture.name} setup did not generate ${path}`);
  }
  return generated;
}

function renderedAgentsTemplateWithAlternatePrefix(): string {
  const templatesUrl = pathToFileURL(join(HEAD_SNAPSHOT_ROOT, "src/setup/templates.ts")).href;
  const child = String.raw`
    import { registerHooks } from "node:module";

    const templatesUrl = ${JSON.stringify(templatesUrl)};
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); }
        catch (error) {
          if (error.code !== "ERR_MODULE_NOT_FOUND" || !/^[@a-z]/i.test(specifier)) throw error;
          return nextResolve(specifier, { ...context, parentURL: import.meta.url });
        }
      },
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (url !== templatesUrl || loaded.source === undefined) return loaded;
        const source = String(loaded.source);
        const declaration = /(\bconst\s+CONSUMER_CLI_PREFIX\s*=\s*)(["'])node \.ut-tdd\/bin\/ut-tdd\.mjs\2/;
        return {
          ...loaded,
          source: source.replace(
            declaration,
            (_match, prefix, quote) => prefix + quote + ${JSON.stringify(ALTERNATE_PREFIX)} + quote,
          ),
        };
      },
    });

    const templates = await import(templatesUrl);
    process.stdout.write(JSON.stringify(templates.BUILTIN_GITHUB_TEMPLATES["adapter/AGENTS.md"]));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    timeout: 30_000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`template child failed (${result.status}): ${result.stderr}`);
  }
  const rendered = JSON.parse(result.stdout) as unknown;
  if (typeof rendered !== "string") throw new Error("template child returned no AGENTS template");
  return rendered;
}

function managedBlock(content: string): string {
  const match = content.match(/<!-- UT-TDD:managed:start -->[\s\S]*?<!-- UT-TDD:managed:end -->/);
  if (!match) throw new Error("generated managed block was not found");
  return match[0];
}

function generatedText(files: Map<string, string>, repoRoot: string): string {
  return [...files.entries()]
    .filter(([path]) => !path.endsWith(".mjs"))
    .map(([path, content]) => `${path.slice(repoRoot.length + 1)}\n${content}`)
    .join("\n");
}

beforeAll(() => {
  const substitutedAgentsTemplate = renderedAgentsTemplateWithAlternatePrefix();
  const substitutedTemplates = {
    ...BUILTIN_GITHUB_TEMPLATES,
    "adapter/AGENTS.md": substitutedAgentsTemplate,
  };

  for (const fixture of FIXTURES) {
    standardFixtures.set(fixture.name, generateFixture(fixture, BUILTIN_GITHUB_TEMPLATES));
    substitutedFixtures.set(fixture.name, generateFixture(fixture, substitutedTemplates));
  }
});

afterAll(() => {
  for (const root of GENERATED_ROOTS) removeTestTree(root);
});

describe("consumer generated instructions sender guidance (#1072)", () => {
  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-008: %s AGENTS managed block has one sender instruction", (fixture) => {
    const agents = standardFixtures.get(fixture.name)?.read("AGENTS.md");
    expect(agents, `${fixture.name} AGENTS.md`).toBeDefined();
    const bullets = managedBlock(agents ?? "")
      .split(/\r?\n/)
      .filter((line) => /^\s*-\s/.test(line) && line.includes("--notify-claude"));
    expect(bullets, `${fixture.name} sender guidance`).toHaveLength(1);
    expect(bullets[0]).toContain(`${DEFAULT_PREFIX} memory add --notify-claude`);
    expect(bullets[0]).toContain("Claude lane に宛てた");
    expect(bullets[0]).toContain("Claude lane に宛てない memory には付けない");
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-008: %s Claude managed blocks exclude sender guidance", (fixture) => {
    for (const path of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
      const content = standardFixtures.get(fixture.name)?.read(path);
      expect(content, `${fixture.name} ${path}`).toBeDefined();
      expect(managedBlock(content ?? "")).not.toContain("--notify-claude");
    }
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-009: %s sender command follows source prefix substitution", (fixture) => {
    const agents = substitutedFixtures.get(fixture.name)?.read("AGENTS.md") ?? "";
    const senderLine = managedBlock(agents)
      .split(/\r?\n/)
      .find((line) => line.includes("--notify-claude"));
    expect(senderLine).toBeDefined();
    expect(senderLine).toContain(`${ALTERNATE_PREFIX} memory add --notify-claude`);
    expect(senderLine).not.toMatch(/(?:^|[\s`(])ut-tdd memory add\b/);
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-009: %s adapter template managed block matches setup output", (fixture) => {
    const agents = standardFixtures.get(fixture.name)?.read("AGENTS.md") ?? "";
    expect(managedBlock(SOURCE_AGENTS_TEMPLATE)).toBe(managedBlock(agents));
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-010: %s generated hook config has no receiver hook", (fixture) => {
    const claudeSettings = JSON.parse(
      standardFixtures.get(fixture.name)?.read(join(".claude", "settings.json")) ?? "{}",
    ) as { hooks?: Record<string, unknown> };
    const codexSettings = JSON.parse(
      standardFixtures.get(fixture.name)?.read(join(".codex", "hooks.json")) ?? "{}",
    ) as { hooks?: Record<string, unknown> };
    expect(claudeSettings.hooks?.UserPromptSubmit).toBeUndefined();
    expect(codexSettings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-010: %s generated text and JSON have no receiver-side guidance", (fixture) => {
    const generated = standardFixtures.get(fixture.name);
    expect(generated).toBeDefined();
    const text = generatedText(generated?.files ?? new Map(), generated?.repoRoot ?? "");
    expect(text).not.toMatch(/notify claude/i);
    expect(text).not.toMatch(/inbox\s+watch/i);
  });

  it.each(
    FIXTURES,
  )("CANDIDATE-U-CGENI-010: %s preserves the 930-second wake timeout", (fixture) => {
    const settings = JSON.parse(
      standardFixtures.get(fixture.name)?.read(join(".claude", "settings.json")) ?? "{}",
    ) as { hooks?: { Stop?: Array<{ hooks?: Array<{ args?: string[]; timeout?: number }> }> } };
    const wakeHooks =
      settings.hooks?.Stop?.flatMap((event) => event.hooks ?? []).filter((hook) =>
        hook.args?.includes("claude-memory-wake"),
      ) ?? [];
    expect(wakeHooks).toHaveLength(1);
    expect(wakeHooks[0]?.timeout).toBe(930);
  });
});
