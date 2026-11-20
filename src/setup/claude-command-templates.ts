import { join } from "node:path";
import type { GeneratedFile } from "./index.ts";

const CLAUDE_COMMAND_TEMPLATES = [
  ["build", "Implement against a frozen UT-TDD spec/test design."],
  ["code-simplify", "Identify the smallest safe simplification for the selected code."],
  ["sdd-plan", "Create a spec-driven UT-TDD plan before implementation."],
  ["sdd-review", "Review a spec/design against UT-TDD trace and gate requirements."],
  ["ship", "Prepare release evidence, rollback notes, and final verification."],
  ["spec", "Author a spec-first design before any implementation."],
  ["test", "Run targeted UT-TDD verification for the current change."],
] as const;

function commandTemplate(name: string, description: string): string {
  return [
    "---",
    `description: ${description}`,
    'argument-hint: "<target>"',
    "---",
    "",
    `Command: ${name}`,
    "",
    "Target: $ARGUMENTS",
    "",
    "Use repository-local UT-TDD commands. Start with `ut-tdd status --json`, run the narrow verification for the target, use `ut-tdd doctor --profile consumer-setup-smoke` for generated adapter/setup health, and use `ut-tdd doctor --profile consumer-toolchain` for consumer-safe toolchain health. Full `ut-tdd doctor` is for source/governance repositories with governance/design/test-design artifacts.",
    "",
  ].join("\n");
}

export const CLAUDE_COMMAND_TEMPLATE_SET: Record<string, string> = Object.fromEntries(
  CLAUDE_COMMAND_TEMPLATES.map(([name, description]) => [
    `adapter/.claude/commands/${name}.md`,
    commandTemplate(name, description),
  ]),
);

export const CLAUDE_COMMAND_FILES: { template: string; file: GeneratedFile }[] =
  CLAUDE_COMMAND_TEMPLATES.map(([name]) => ({
    template: `adapter/.claude/commands/${name}.md`,
    file: {
      path: join(".claude", "commands", `${name}.md`),
      category: "A",
      purpose: `Claude slash command template: ${name}`,
    },
  }));
