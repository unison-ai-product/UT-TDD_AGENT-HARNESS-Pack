import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCodexHookAdapter,
  checkCodexWrapperParity,
  checkGithubCiPolicy,
  checkProjectHooks,
  type RuntimeSurfaceDeps,
} from "../src/doctor/runtime-surface";

function wrapperParityFiles(root: string, overrides: Record<string, string> = {}) {
  const file = (relativePath: string) => join(root, ...relativePath.split("/"));
  return new Map<string, string>(
    Object.entries({
      ".claude/settings.json": JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session start' }],
            },
          ],
          PostToolUse: [
            {
              hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" hook post-tool-use' }],
            },
          ],
          Stop: [
            {
              hooks: [{ command: 'bun "$CLAUDE_PROJECT_DIR/src/cli.ts" session summary' }],
            },
          ],
        },
      }),
      "src/runtime/adapter.ts":
        "const args = CODEX_STDIN_ARGS; return { stdin: intent.task, plan_id: intent.planId };",
      "src/runtime/adapter-policy.ts": 'export const CODEX_STDIN_ARGS = ["exec", "-"] as const;',
      "tests/runtime-hook-entrypoints.test.ts": [
        "ut-tdd codex --execute records the same session lifecycle through the adapter wrapper",
        "ut-tdd codex --task-file feeds file content through the same adapter wrapper",
        "ut-tdd codex --plan records wrapper lifecycle without forwarding plan flags to Codex",
      ].join("\n"),
      "tests/runtime-adapter.test.ts": "U-ADAPTER-007\nU-ADAPTER-008",
      "docs/test-design/harness/L7-unit-test-design.md": "U-ADAPTER-009",
      ...overrides,
    }).map(([relativePath, text]) => [file(relativePath), text]),
  );
}

function deps(root: string, files = wrapperParityFiles(root)): RuntimeSurfaceDeps {
  return {
    repoRoot: root,
    readText: (path) => files.get(path) ?? null,
  };
}

describe("doctor runtime surface checks", () => {
  it("keeps wrapper parity independent from DoctorDeps shape", () => {
    const root = process.cwd();

    const result = checkCodexWrapperParity(deps(root));

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("codex-wrapper-parity - OK");
  });

  it("fails closed when runtime surface repo root is missing", () => {
    const missingRoot = join(process.cwd(), ".missing-runtime-surface-root");

    expect(checkProjectHooks(missingRoot).ok).toBe(false);
    expect(checkGithubCiPolicy(missingRoot).ok).toBe(false);
    expect(checkCodexHookAdapter(missingRoot).ok).toBe(false);
    expect(checkCodexWrapperParity(deps(missingRoot)).ok).toBe(false);
  });
});
