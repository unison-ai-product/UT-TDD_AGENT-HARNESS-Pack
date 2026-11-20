import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, heavyAfterAll, heavyBeforeAll, it } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

type Scenario = "normal" | "duplicate" | "occupied" | "unsupported";

type Entry =
  | { kind: "seed"; final: string; initial: string }
  | { kind: "read"; final: string }
  | { kind: "stage"; staged: string }
  | { kind: "link"; staged: string; final: string }
  | { kind: "link-error"; code: string };

const snapshotRoot = process.cwd();
const cliPath = join(snapshotRoot, "src", "cli.ts");
const preloadUrl = pathToFileURL(join(snapshotRoot, "tests/support/gate-publish-preload.mjs")).href;
const warning = "gate run evidence write failed";

function runGate(root: string, scenario: Scenario, approved: boolean, json: boolean) {
  const args = [
    "--import",
    preloadUrl,
    cliPath,
    "gate",
    "G0.5",
    "--mode",
    "standalone",
    "--review-kind",
    "human",
  ];
  if (approved) args.push("--human-approved");
  if (json) args.push("--json");
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      UT_TDD_PLAN_ID: "",
      UT_TDD_SESSION_ID: "gate-publish-fixture",
      UT_TDD_TEST_GATE_PUBLISH: scenario,
    },
    timeout: 30_000,
    windowsHide: true,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.status, run.stderr).toBe(approved ? 0 : 1);

  const output = json ? JSON.parse(run.stdout) : undefined;
  const verdict = approved ? "passed" : "failed";
  if (json) {
    expect(output.passed).toBe(approved);
  } else {
    expect(run.stdout).toMatch(new RegExp(`^gate G0\\.5: ${verdict}\\b`, "m"));
    expect(run.stdout).not.toContain(warning);
  }
  const gateWarning = json
    ? output.gate_run_evidence_warning
    : run.stderr.split(/\r?\n/).find((line) => line.includes(warning));
  const evidence = json ? output.gate_run_evidence : /^\s*- evidence: /m.test(run.stdout);
  const directory = join(root, ".ut-tdd", "gate_runs");
  const entries = readFileSync(join(root, "publish-observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry);
  const finals = readdirSync(directory).filter((name) => name.endsWith(".json"));
  return { gateWarning, evidence, directory, entries, finals };
}

function assertLink(run: ReturnType<typeof runGate>, code?: string) {
  const stages = run.entries.filter((entry) => entry.kind === "stage");
  const links = run.entries.filter((entry) => entry.kind === "link");
  expect(stages).toHaveLength(1);
  expect(links).toHaveLength(1);
  const [link] = links;
  expect(link.staged).toBe(stages[0].staged);
  expect(dirname(link.staged)).toBe(run.directory);
  expect(dirname(link.final)).toBe(run.directory);
  expect(run.entries.filter((entry) => entry.kind === "link-error")).toEqual(
    code ? [{ kind: "link-error", code }] : [],
  );
  return link.final;
}

function assertSeedIsPreserved(run: ReturnType<typeof runGate>) {
  const seeds = run.entries.filter((entry) => entry.kind === "seed");
  expect(seeds).toHaveLength(1);
  expect(run.finals).toHaveLength(1);
  expect(readFileSync(seeds[0].final, "utf8")).toBe(seeds[0].initial);
  return seeds[0].final;
}

for (const approved of [true, false]) {
  for (const json of [true, false]) {
    describe(`G0.5 ${approved ? "passed" : "failed"}, ${json ? "JSON" : "human"}`, () => {
      const roots: string[] = [];
      let duplicateWarning: string;
      function execute(scenario: Scenario) {
        const root = mkdtempSync(join(tmpdir(), "ut-tdd-gate-cli-publish-"));
        roots.push(root);
        return runGate(root, scenario, approved, json);
      }

      heavyBeforeAll("db", () => {
        const normal = execute("normal");
        const normalFinal = assertLink(normal);
        expect(normal.finals).toHaveLength(1);
        expect(existsSync(normalFinal)).toBe(true);
        expect(normal.gateWarning ?? null).toBeNull();
        expect(normal.evidence).toBeTruthy();

        const duplicate = execute("duplicate");
        const duplicateFinal = assertSeedIsPreserved(duplicate);
        expect(duplicate.entries).toEqual([
          expect.objectContaining({ kind: "seed" }),
          { kind: "read", final: duplicateFinal },
        ]);
        expect(duplicate.gateWarning).toContain(warning);
        expect(duplicate.evidence).toBe(json ? null : false);
        duplicateWarning = duplicate.gateWarning;
      });

      heavyAfterAll("teardown", () => {
        for (const root of roots) removeTestTree(root);
      });

      it("U-GATEPUB-001: identifies a duplicate ID as EEXIST", () => {
        expect(duplicateWarning).toContain("EEXIST");
      });

      it("U-GATEPUB-001: reports native link EEXIST and preserves the contender", () => {
        const occupied = execute("occupied");
        expect(assertLink(occupied, "EEXIST")).toBe(assertSeedIsPreserved(occupied));
        expect(occupied.gateWarning).toContain(warning);
        expect(occupied.gateWarning).toContain("EEXIST");
        expect(occupied.evidence).toBe(json ? null : false);
      }, 45_000);

      it("U-GATEPUB-002: reports ENOTSUP without publishing a fallback final", () => {
        const failed = execute("unsupported");
        const final = assertLink(failed, "ENOTSUP");
        expect(existsSync(final)).toBe(false);
        expect(failed.finals).toEqual([]);
        expect(failed.gateWarning).toContain(warning);
        expect(failed.gateWarning).toContain("ENOTSUP");
        expect(failed.evidence).toBe(json ? null : false);
      }, 45_000);
    });
  }
}
