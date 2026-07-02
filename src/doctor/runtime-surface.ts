import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeCodexHookAdapter,
  codexHookAdapterMessages,
  loadCodexHookAdapterInput,
} from "../lint/codex-hook-adapter";
import {
  analyzeGithubCiPolicy,
  githubCiPolicyMessages,
  loadGithubCiPolicyDocs,
} from "../lint/github-ci-policy";
import {
  analyzeProjectHooks,
  loadProjectHookDocs,
  projectHookMessages,
} from "../lint/project-hook";

export interface RuntimeSurfaceDeps {
  repoRoot: string;
  readText: (path: string) => string | null;
}

export function checkProjectHooks(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["project-hook - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeProjectHooks(loadProjectHookDocs(repoRoot));
    return { messages: projectHookMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["project-hook - violation: project hook settings could not be read"],
      ok: false,
    };
  }
}

export function checkGithubCiPolicy(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["github-ci-policy - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeGithubCiPolicy(loadGithubCiPolicyDocs(repoRoot));
    return { messages: githubCiPolicyMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["github-ci-policy - violation: GitHub workflow policy could not be read"],
      ok: false,
    };
  }
}

export function checkCodexHookAdapter(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["codex-hook-adapter - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeCodexHookAdapter(loadCodexHookAdapterInput(repoRoot));
    return { messages: codexHookAdapterMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["codex-hook-adapter - violation: Codex hooks.json could not be read"],
      ok: false,
    };
  }
}

export function checkCodexWrapperParity(deps: RuntimeSurfaceDeps): {
  messages: string[];
  ok: boolean;
} {
  if (!existsSync(deps.repoRoot)) {
    return {
      messages: ["codex-wrapper-parity - violation: repo root could not be read"],
      ok: false,
    };
  }

  const requiredFiles = [
    join(deps.repoRoot, ".claude", "settings.json"),
    join(deps.repoRoot, "src", "runtime", "adapter.ts"),
    join(deps.repoRoot, "src", "runtime", "adapter-policy.ts"),
    join(deps.repoRoot, "tests", "runtime-hook-entrypoints.test.ts"),
    join(deps.repoRoot, "tests", "runtime-adapter.test.ts"),
    join(deps.repoRoot, "docs", "test-design", "harness", "L7-unit-test-design.md"),
  ];
  const reads = new Map(requiredFiles.map((path) => [path, deps.readText(path)]));
  const missing = requiredFiles.filter((path) => reads.get(path) === null);
  if (missing.length > 0) {
    return {
      messages: [
        `codex-wrapper-parity - violation: parity evidence could not be read (${missing
          .map((path) => path.replace(`${deps.repoRoot}\\`, "").replace(`${deps.repoRoot}/`, ""))
          .join(", ")})`,
      ],
      ok: false,
    };
  }

  const settings = reads.get(requiredFiles[0]) ?? "";
  const adapter = reads.get(requiredFiles[1]) ?? "";
  const adapterPolicy = reads.get(requiredFiles[2]) ?? "";
  const hookTests = reads.get(requiredFiles[3]) ?? "";
  const adapterTests = reads.get(requiredFiles[4]) ?? "";
  const testDesign = reads.get(requiredFiles[5]) ?? "";
  const violations: string[] = [];
  const settingStrings: string[] = [];
  try {
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        settingStrings.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value)) walk(item);
      }
    };
    walk(JSON.parse(settings));
  } catch {
    violations.push(".claude/settings.json must be valid JSON");
  }

  const claudeHookCommands = [
    'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start',
    'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" hook post-tool-use',
    'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session summary',
  ];
  for (const command of claudeHookCommands) {
    if (!settingStrings.includes(command)) {
      violations.push(`Claude project hook command missing: ${command}`);
    }
  }

  const adapterUsesCodexPolicy =
    adapter.includes("CODEX_STDIN_ARGS") &&
    adapterPolicy.includes('CODEX_STDIN_ARGS = ["exec", "-"]');
  if (!/\?\s*\[\s*"exec"[\s\S]*"-"\s*\]/.test(adapter) && !adapterUsesCodexPolicy) {
    violations.push("Codex adapter args must use fixed `exec -` stdin sentinel");
  }
  if (!/stdin:\s*(intent\.task|formatAdapterPrompt\(intent\.task,)/.test(adapter)) {
    violations.push("Codex/Claude adapter task text must be carried by stdin");
  }
  if (!/plan_id:\s*intent\.planId/.test(adapter)) {
    violations.push("adapter plan id must remain harness metadata");
  }

  const codexWrapperTests = [
    "ut-tdd codex --execute records the same session lifecycle through the adapter wrapper",
    "ut-tdd codex --task-file feeds file content through the same adapter wrapper",
    "ut-tdd codex --plan records wrapper lifecycle without forwarding plan flags to Codex",
  ];
  for (const testName of codexWrapperTests) {
    if (!hookTests.includes(testName)) {
      violations.push(`Codex wrapper lifecycle test missing: ${testName}`);
    }
  }

  if (!adapterTests.includes("U-ADAPTER-007") || !adapterTests.includes("U-ADAPTER-008")) {
    violations.push("runtime adapter stdin oracles U-ADAPTER-007/U-ADAPTER-008 must be cited");
  }
  if (!testDesign.includes("U-ADAPTER-009")) {
    violations.push("U-ADAPTER-009 codex-wrapper-parity oracle must be documented");
  }

  if (violations.length > 0) {
    return {
      messages: violations.map((violation) => `codex-wrapper-parity - violation: ${violation}`),
      ok: false,
    };
  }

  return {
    messages: [
      "codex-wrapper-parity - OK (claude_hooks=project-settings, codex=ut-tdd-wrapper-lifecycle, adapter=stdin)",
    ],
    ok: true,
  };
}
