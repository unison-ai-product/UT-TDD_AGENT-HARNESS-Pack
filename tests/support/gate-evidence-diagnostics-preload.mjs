import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";

const root = process.cwd();
const directory = join(root, ".ut-tdd", "gate_runs");
const log = join(root, "gate-evidence-observations.jsonl");
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalLinkSync = fs.linkSync;

function record(entry) {
  originalWriteFileSync(log, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}

fs.readFileSync = (path, ...args) => {
  if (typeof path === "string" && dirname(path) === directory && path.endsWith(".json")) {
    record({ kind: "read", path: basename(path) });
  }
  return originalReadFileSync(path, ...args);
};

fs.writeFileSync = (path, ...args) => {
  if (typeof path === "string" && dirname(path) === directory && basename(path).startsWith(".tmp-")) {
    record({ kind: "stage", path: basename(path) });
  }
  return originalWriteFileSync(path, ...args);
};

fs.linkSync = (staged, final) => {
  if (typeof final === "string" && dirname(final) === directory) {
    record({ kind: "link", staged: basename(staged), final: basename(final) });
  }
  return originalLinkSync(staged, final);
};

syncBuiltinESMExports();

if (process.env.UT_TDD_TEST_GATE_DIAG_DIRECT === "1") {
  const { writeGateRunEvidence } = await import("../../src/gate/run-evidence.ts");
  try {
    const result = writeGateRunEvidence({
      repoRoot: root,
      gateId: "G0.5",
      checkedAt: "2026-11-24T00:00:00.000Z",
      sessionId: "gate-evidence-diagnostics-fixture",
      status: "passed",
    });
    process.stdout.write(`${JSON.stringify({ ok: true, path: result.path })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code: error && typeof error === "object" ? error.code ?? null : null,
        message: error instanceof Error ? error.message : String(error),
        hasCause: Boolean(error && typeof error === "object" && "cause" in error),
      })}\n`,
    );
  }
}
