import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCleanPack,
  createConsumerProject,
  fixtureRoots,
  removeFixtureTree,
  runConsumer,
  setupConsumerFromPack,
  startConsumerWake,
  stopConsumerWakeProcesses,
  waitForConsumerWakeTarget,
  writeConsumerRuntimeInput,
} from "./support/pack-consumer-runtime.ts";

function runConfiguredHook(root: string, provider: "claude" | "codex") {
  const settingsPath = provider === "claude" ? ".claude/settings.json" : ".codex/hooks.json";
  const settings = JSON.parse(readFileSync(join(root, settingsPath), "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args: string[] }> }> };
  };
  const command = settings.hooks.PreToolUse[0].hooks[0];
  expect(command.args.join(" ")).toContain(".ut-tdd/bin/ut-tdd.mjs");
  return spawnSync(command.command, command.args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    input: JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: "pmo-haiku", model: "haiku" },
    }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      UT_TDD_PROJECT_DIR: root,
      UT_TDD_SKIP_UPDATE_CHECK: "1",
    },
  });
}

function removeInput(inputPath: string): void {
  rmSync(inputPath, { force: true });
}

afterEach(() => {
  stopConsumerWakeProcesses();
  for (const root of fixtureRoots.splice(0)) removeFixtureTree(root);
});

describe("Issue #424 Slice 5 clean Pack/provider parity", () => {
  it("CANDIDATE-P-PMEMROOT-002: consumer runtime keeps CLI, both provider hooks, Memory, and Claude wake after Pack removal", async () => {
    const pack = createCleanPack();
    const consumer = createConsumerProject("fixture/consumer-primary");
    const input = await writeConsumerRuntimeInput(pack, consumer);
    setupConsumerFromPack(pack, consumer, input);
    removeInput(input);
    removeFixtureTree(pack);

    const cli = runConsumer(consumer, ["--help"]);
    expect(cli.status, `${cli.stdout}\n${cli.stderr}`).toBe(0);
    expect(cli.stdout).toContain("Usage");
    expect(existsSync(join(consumer, ".ut-tdd", "bin", "ut-tdd.mjs"))).toBe(true);
    const wrapperBytes = readFileSync(join(consumer, ".ut-tdd", "bin", "ut-tdd.mjs"), "utf8");
    expect(wrapperBytes).not.toContain(pack);
    for (const file of [".claude/settings.json", ".codex/hooks.json"])
      expect(readFileSync(join(consumer, file), "utf8")).not.toMatch(
        /(?:src[\\/]cli\.ts|src[\\/]setup[\\/]index\.ts|UT_TDD_SOURCE_CLI|SETUP_SOURCE_CLI)/,
      );

    for (const provider of ["claude", "codex"] as const) {
      const hook = runConfiguredHook(consumer, provider);
      expect(hook.status, `${provider}: ${hook.stdout}\n${hook.stderr}`).toBe(0);
      expect(hook.stderr).not.toContain("BLOCK");
    }

    const added = runConsumer(consumer, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "clean Pack shared memory",
      "--body",
      "published from the consumer runtime",
    ]);
    expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);
    const listed = runConsumer(consumer, ["memory", "list", "--query", "clean Pack shared memory"]);
    expect(listed.status, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    expect(listed.stdout).toContain("clean Pack shared memory");

    const wake = startConsumerWake(consumer, "pack-consumer-claude");
    await waitForConsumerWakeTarget(consumer);
    const notified = runConsumer(consumer, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "clean Pack provider parity notification",
      "--body",
      "published from the consumer runtime",
      "--notify-claude",
      "--operation-id",
      "clean-pack-provider-parity",
    ]);
    expect(notified.status, `${notified.stdout}\n${notified.stderr}`).toBe(0);
    const delivered = await wake.result;
    expect(delivered.code, `${delivered.stdout}\n${delivered.stderr}`).toBe(2);
    expect(delivered.stderr).toContain("[UT_TDD_CLAUDE_INBOX]");
    expect(delivered.stderr).toContain("published from the consumer runtime");
    expect(delivered.stderr).toContain('"operation_id":"clean-pack-provider-parity"');
    const published = notified.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("memory: notified Claude via "))
      ?.slice("memory: notified Claude via ".length);
    expect(published).toBeTruthy();
    expect(existsSync(published as string)).toBe(false);
  }, 420_000);

  it("CANDIDATE-P-PMEMROOT-003: a foreign consumer cannot read or claim another project's Memory/provider entry", async () => {
    const pack = createCleanPack();
    const primary = createConsumerProject("fixture/consumer-primary");
    const foreign = createConsumerProject("fixture/consumer-foreign");
    const primaryInput = await writeConsumerRuntimeInput(pack, primary);
    setupConsumerFromPack(pack, primary, primaryInput);
    removeInput(primaryInput);
    const foreignInput = await writeConsumerRuntimeInput(pack, foreign);
    setupConsumerFromPack(pack, foreign, foreignInput);
    removeInput(foreignInput);
    removeFixtureTree(pack);

    const added = runConsumer(primary, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "isolated Pack memory",
      "--body",
      "must not cross the project namespace",
    ]);
    expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);
    const primaryList = runConsumer(primary, ["memory", "list", "--query", "isolated Pack memory"]);
    expect(primaryList.stdout).toContain("isolated Pack memory");
    const foreignList = runConsumer(foreign, ["memory", "list", "--query", "isolated Pack memory"]);
    expect(foreignList.status, `${foreignList.stdout}\n${foreignList.stderr}`).toBe(0);
    expect(foreignList.stdout).not.toContain("isolated Pack memory");

    // Produce a real provider envelope through the consumer CLI, then stop the
    // primary wake before delivery so the foreign runtime can be challenged with
    // the original project-bound bytes. No source/Pack CLI is used below this boundary.
    const wake = startConsumerWake(primary, "pack-primary-codex");
    await waitForConsumerWakeTarget(primary);
    wake.child.kill();
    await wake.result;
    const notified = runConsumer(primary, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "isolated Pack provider entry",
      "--body",
      "primary project only",
      "--notify-claude",
      "--operation-id",
      "isolated-pack-provider",
    ]);
    expect(notified.status, `${notified.stdout}\n${notified.stderr}`).toBe(0);
    const published = notified.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("memory: notified Claude via "))
      ?.slice("memory: notified Claude via ".length);
    expect(published).toBeTruthy();

    const foreignWake = startConsumerWake(foreign, "foreign-claude");
    await waitForConsumerWakeTarget(foreign);
    const foreignWakeRoot = findWakeRoot(foreign);
    mkdirSync(join(foreignWakeRoot, "inbox"), { recursive: true });
    mkdirSync(join(foreignWakeRoot, "envelope-bindings"), { recursive: true });
    const entry = JSON.parse(readFileSync(published as string, "utf8")) as {
      [key: string]: unknown;
      projectId: string;
      memoryId: string;
      operationId: string;
      producer: Record<string, string>;
      target: Record<string, string>;
    };
    const generationFile = readdirSync(foreignWakeRoot).find((name) =>
      name.endsWith(".generation"),
    );
    if (!generationFile) throw new Error("foreign_claude_generation_missing");
    const workspaceId = (
      JSON.parse(readFileSync(join(foreignWakeRoot, generationFile), "utf8")) as {
        workspaceId: string;
      }
    ).workspaceId;
    const target = { ...entry.target, sessionId: "foreign-claude" };
    const envelopeDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: "ut-tdd.claude-inbox/v4",
          projectId: entry.projectId,
          memoryId: entry.memoryId,
          operationId: entry.operationId,
          producer: entry.producer,
          target,
        }),
      )
      .digest("hex");
    const forged = {
      ...entry,
      id: `${entry.memoryId}:project:${entry.projectId}:op:${entry.operationId}:env:${envelopeDigest.slice(0, 16)}`,
      targetWorkspaceId: workspaceId,
      target,
      envelopeDigest,
    };
    const safeId = forged.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 147);
    const forgedName = `${safeId}_${createHash("sha256").update(forged.id).digest("hex").slice(0, 12)}.json`;
    writeFileSync(join(foreignWakeRoot, "inbox", forgedName), `${JSON.stringify(forged)}\n`);
    writeFileSync(
      join(foreignWakeRoot, "envelope-bindings", forgedName),
      `${JSON.stringify({
        schemaVersion: "ut-tdd.claude-provider-binding/v1",
        entryId: forged.id,
        projectId: forged.projectId,
        memoryId: forged.memoryId,
        operationId: forged.operationId,
        producer: forged.producer,
        target: forged.target,
        envelopeDigest: forged.envelopeDigest,
      })}\n`,
    );
    const foreignWakeResult = await foreignWake.result;
    expect(foreignWakeResult.code).not.toBe(2);
    expect(foreignWakeResult.stderr).toContain("project_id_mismatch");
    expect(existsSync(join(foreignWakeRoot, "inbox", forgedName))).toBe(true);
    expect(readdirSync(foreignWakeRoot).some((name) => name.endsWith(".claim"))).toBe(false);
  }, 420_000);
});

function findWakeRoot(root: string): string {
  const projects = join(root, ".git", "ut-tdd-runtime", "projects");
  const namespace = readdirSync(projects).find((name) => !name.startsWith("."));
  if (!namespace) throw new Error("consumer_runtime_project_namespace_missing");
  return join(projects, namespace, "claude-memory-wake");
}
