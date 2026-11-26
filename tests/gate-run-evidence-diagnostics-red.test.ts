import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, heavyBeforeAll, it } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// The execution snapshot is the module source for the spawned real writer and CLI.
const snapshotRoot = process.cwd();
const cliPath = join(snapshotRoot, "src", "cli.ts");
const preloadUrl = pathToFileURL(
  join(snapshotRoot, "tests", "support", "gate-evidence-diagnostics-preload.mjs"),
).href;
const evidenceRelative = ".ut-tdd/gate_runs";
const malformedBytes = '{"fixture":"UT1490_MALFORMED_JSON_SENTINEL"\n';
const nullBytes = "null\n";
const warningPrefix = "gate run evidence write failed: ";
const diagnosticPrefix = "existing_evidence_scan_failed: ";

type FailureFixture = "read" | "malformed" | "null";

function makeRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `ut-tdd ${label}-`));
}

function seedFixture(root: string, fixture: FailureFixture): { path: string; bytes: string } {
  const directory = join(root, evidenceRelative);
  mkdirSync(directory, { recursive: true });
  const name =
    fixture === "read"
      ? "physical read failure.json"
      : fixture === "malformed"
        ? "malformed sentinel.json"
        : "valid JSON value evidence.json";
  const path = join(directory, name);
  if (fixture === "read") mkdirSync(path);
  else writeFileSync(path, fixture === "malformed" ? malformedBytes : nullBytes, "utf8");
  return { path, bytes: fixture === "malformed" ? malformedBytes : nullBytes };
}

function runDirectWriter(root: string) {
  const run = spawnSync(process.execPath, ["--import", preloadUrl], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, UT_TDD_TEST_GATE_DIAG_DIRECT: "1" },
    timeout: 30_000,
    windowsHide: true,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout.trim()) as {
    ok: boolean;
    code?: string | null;
    message?: string;
    hasCause?: boolean;
  };
  return { result, entries: observations(root) };
}

function observations(root: string) {
  const log = join(root, "gate-evidence-observations.jsonl");
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind: string; path?: string; final?: string })
    : [];
}

function assertNoPublication(entries: Array<{ kind: string }>): void {
  expect(entries.filter((entry) => entry.kind === "stage")).toEqual([]);
  expect(entries.filter((entry) => entry.kind === "link")).toEqual([]);
}

function nativeReadError(path: string): string {
  try {
    readFileSync(path, "utf8");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("directory read unexpectedly succeeded");
}

function parserError(bytes: string): string {
  try {
    JSON.parse(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("malformed fixture unexpectedly parsed");
}

function nullPropertyError(): string {
  try {
    const existing = JSON.parse(nullBytes) as { gate_run_id?: unknown };
    return String(existing.gate_run_id);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function runCli(root: string, approved = true, json = false) {
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
      UT_TDD_SESSION_ID: "gate-evidence-diagnostics-fixture",
      UT_TDD_TEST_GATE_DIAG_DIRECT: "",
    },
    timeout: 30_000,
    windowsHide: true,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  const expectedStatus = approved ? 0 : 1;
  expect(run.status, run.stderr).toBe(expectedStatus);
  if (!json) {
    const summary = run.stdout.match(/^gate G0\.5: (passed|failed)\b/m);
    expect(summary?.[1]).toBe(approved ? "passed" : "failed");
    const warningLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => /^\s+- gate run evidence write failed: /.test(line));
    return {
      status: run.status,
      passed: summary?.[1] === "passed",
      warning: warningLines.map((line) => line.replace(/^\s+- /, ""))[0] ?? null,
      warningLines,
      evidence: /^\s+- evidence: /m.test(run.stdout),
      stdout: run.stdout,
      stderr: run.stderr,
    };
  }
  const output = JSON.parse(run.stdout) as {
    passed: boolean;
    gate_run_evidence_warning: string | null;
    gate_run_evidence: { path: string; gate_run_id: string } | null;
  };
  expect(output.passed).toBe(approved);
  expect(run.stderr).not.toContain(warningPrefix);
  return {
    status: run.status,
    passed: output.passed,
    warning: output.gate_run_evidence_warning,
    warningLines: [] as string[],
    evidence: output.gate_run_evidence,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

function expectedWarning(relativePath: string): string {
  return `${warningPrefix}${diagnosticPrefix}${JSON.stringify(relativePath)}`;
}

function forbiddenDetails(fixture: FailureFixture, path: string): string[] {
  const details = [path, path.replaceAll("\\", "/")];
  if (fixture === "read") details.push(nativeReadError(path));
  if (fixture === "malformed")
    details.push("UT1490_MALFORMED_JSON_SENTINEL", parserError(malformedBytes));
  if (fixture === "null") details.push(nullPropertyError(), nullBytes.trim());
  return [...new Set(details.filter(Boolean))];
}

function assertWarningIsSanitized(
  warning: string | null,
  expected: string,
  forbidden: string[],
): void {
  expect(warning).toBe(expected);
  for (const detail of forbidden) expect.soft(warning).not.toContain(detail);
}

const fixtures = ["read", "malformed", "null"] as const;

function observeDirectFailure(kind: FailureFixture) {
  const root = makeRoot("gate diagnostics writer");
  try {
    const fixture = seedFixture(root, kind);
    const directory = join(root, evidenceRelative);
    const staged = join(directory, ".tmp-preexisting-stage");
    const final = join(directory, "preexisting-final.json");
    writeFileSync(staged, "stage bytes\n", "utf8");
    writeFileSync(final, '{"gate_run_id":"unrelated-final"}\n', "utf8");
    const before = readdirSync(directory).sort();
    const forbidden = forbiddenDetails(kind, fixture.path);
    const { result, entries } = runDirectWriter(root);
    expect(result.ok).toBe(false);
    expect(entries).toContainEqual({ kind: "read", path: basename(fixture.path) });
    assertNoPublication(entries);
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(readFileSync(staged, "utf8")).toBe("stage bytes\n");
    expect(readFileSync(final, "utf8")).toBe('{"gate_run_id":"unrelated-final"}\n');
    if (kind === "read") {
      expect(lstatSync(fixture.path).isDirectory()).toBe(true);
    } else {
      expect(readFileSync(fixture.path, "utf8")).toBe(fixture.bytes);
    }
    return { result, path: `${evidenceRelative}/${basename(fixture.path)}`, forbidden };
  } finally {
    removeTestTree(root);
  }
}

function expectWriterDiagnostic(observed: ReturnType<typeof observeDirectFailure>) {
  expect(observed.result.code).toBe("existing_evidence_scan_failed");
  expect.soft(observed.result.message).toBe(diagnosticPrefix + JSON.stringify(observed.path));
  expect.soft(observed.result.hasCause).toBe(false);
  for (const detail of observed.forbidden)
    expect.soft(observed.result.message).not.toContain(detail);
}

describe("direct gate evidence writer", () => {
  let observed: Record<FailureFixture, ReturnType<typeof observeDirectFailure>>;
  heavyBeforeAll("db", () => {
    observed = {
      read: observeDirectFailure("read"),
      malformed: observeDirectFailure("malformed"),
      null: observeDirectFailure("null"),
    };
  });

  it("does not publish on existing-evidence failures and observes a real healthy publication", () => {
    expect(Object.values(observed).map((entry) => entry.result.ok)).toEqual([false, false, false]);
    const root = makeRoot("gate diagnostics writer control");
    try {
      const { result, entries } = runDirectWriter(root);
      expect(result.ok).toBe(true);
      expect(entries.map((entry) => entry.kind)).toEqual(["stage", "link"]);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-GATEDIAG-001: sanitizes a physical read failure", () => {
    expectWriterDiagnostic(observed.read);
  });

  it("U-GATEDIAG-002: sanitizes malformed and null evidence", () => {
    expectWriterDiagnostic(observed.malformed);
    expectWriterDiagnostic(observed.null);
  });
});

for (const approved of [true, false]) {
  for (const json of [false, true]) {
    describe(`G0.5 ${approved ? "passed" : "failed"} ${json ? "JSON" : "human"}`, () => {
      let rejected: Array<{
        run: ReturnType<typeof runCli>;
        path: string;
        forbidden: string[];
      }>;

      heavyBeforeAll("db", () => {
        const controlRoot = makeRoot("gate diagnostics CLI control");
        let control: ReturnType<typeof runCli>;
        try {
          control = runCli(controlRoot, approved, json);
          expect(control.warning).toBeNull();
          expect(control.evidence).toBeTruthy();
          expect(observations(controlRoot).map((entry) => entry.kind)).toEqual(["stage", "link"]);
        } finally {
          removeTestTree(controlRoot);
        }

        rejected = fixtures.map((kind) => {
          const root = makeRoot("gate diagnostics CLI");
          try {
            const fixture = seedFixture(root, kind);
            const run = runCli(root, approved, json);
            const name = basename(fixture.path);
            const entries = observations(root);
            expect(entries).toContainEqual({ kind: "read", path: name });
            assertNoPublication(entries);
            expect(run.status).toBe(control.status);
            expect(run.passed).toBe(control.passed);
            expect(run.evidence).toBe(json ? null : false);
            expect(readdirSync(join(root, evidenceRelative))).toEqual([name]);
            if (kind === "read") {
              expect(lstatSync(fixture.path).isDirectory()).toBe(true);
            } else {
              expect(readFileSync(fixture.path, "utf8")).toBe(fixture.bytes);
            }
            return {
              run,
              path: `${evidenceRelative}/${name}`,
              forbidden: forbiddenDetails(kind, fixture.path),
            };
          } finally {
            removeTestTree(root);
          }
        });
      });

      it("preserves the real gate verdict and refuses publication for all three inputs", () => {
        expect(rejected).toHaveLength(3);
      });

      it("U-GATEDIAG-003: emits only the path diagnostic", () => {
        for (const { run, path, forbidden } of rejected) {
          const expected = expectedWarning(path);
          assertWarningIsSanitized(run.warning, expected, forbidden);
          if (json) {
            expect.soft(run.stderr).not.toContain(warningPrefix);
          } else {
            expect.soft(run.warningLines).toEqual([`  - ${expected}`]);
            expect.soft(run.stdout).not.toContain(warningPrefix);
          }
        }
      });
    });
  }
}
