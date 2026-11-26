import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_GITHUB_TEMPLATES } from "../src/setup/templates.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

type Hook = Record<string, unknown>;
type Provider = "claude" | "codex";

const claudeMirror = readFileSync(
  join(headSnapshotRoot(), "docs/templates/adapter/.claude/settings.json"),
  "utf8",
);
const codexMirror = readFileSync(
  join(headSnapshotRoot(), "docs/templates/adapter/.codex/hooks.json"),
  "utf8",
);

function sessionStartHook(source: string, provider: Provider): Hook {
  const settings = JSON.parse(source) as {
    hooks?: Record<string, Array<{ hooks?: Hook[] }>>;
  };
  expect(settings).toBeTypeOf("object");
  expect(settings.hooks).toBeTypeOf("object");

  const event = settings.hooks?.SessionStart;
  expect(event).toHaveLength(1);
  const hooks = event?.[0]?.hooks;
  expect(hooks).toHaveLength(1);

  const hook = hooks?.[0];
  expect(hook?.type).toBe("command");
  expect([undefined, false]).toContain(hook?.async);
  expect(hook).not.toHaveProperty("onFailure");
  if (provider === "claude") {
    expect(hook?.command).toBe("node");
    expect(hook?.args).toEqual([".ut-tdd/bin/ut-tdd.mjs", "session", "start"]);
  } else {
    expect(hook?.command).toBe(
      'node "$(git rev-parse --show-toplevel)/.ut-tdd/bin/ut-tdd.mjs" session start',
    );
  }
  return hook ?? {};
}

describe("Pack consumer Claude SessionStart timeout", () => {
  let hook: Hook;

  beforeAll(() => {
    hook = sessionStartHook(claudeMirror, "claude");
  });

  it("CANDIDATE-U-PACKSTART-001", () => expect(hook.timeout).toBe(60));
});

describe("Pack consumer Codex SessionStart timeout", () => {
  let hook: Hook;

  beforeAll(() => {
    hook = sessionStartHook(codexMirror, "codex");
  });

  it("CANDIDATE-U-PACKSTART-002", () => expect(hook.timeout).toBe(60));
});

describe("setup generated Claude SessionStart timeout", () => {
  let hook: Hook;

  beforeAll(() => {
    hook = sessionStartHook(BUILTIN_GITHUB_TEMPLATES["adapter/.claude/settings.json"], "claude");
  });

  it("CANDIDATE-U-PACKSTART-003", () => expect(hook.timeout).toBe(60));
});

describe("setup generated Codex SessionStart timeout", () => {
  let hook: Hook;

  beforeAll(() => {
    hook = sessionStartHook(BUILTIN_GITHUB_TEMPLATES["adapter/.codex/hooks.json"], "codex");
  });

  it("CANDIDATE-U-PACKSTART-004", () => expect(hook.timeout).toBe(60));
});
