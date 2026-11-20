import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { buildGateRunEvidence } from "../../src/gate/run-evidence.ts";

const root = process.cwd();
const directory = join(root, ".ut-tdd", "gate_runs");
const log = join(root, "publish-observations.jsonl");
const scenario = process.env.UT_TDD_TEST_GATE_PUBLISH;
const { readFileSync, writeFileSync, linkSync } = fs;
const isStage = (path) =>
  typeof path === "string" && dirname(path) === directory && basename(path).startsWith(".tmp-");

function record(entry) {
  fs.appendFileSync(log, `${JSON.stringify(entry)}\n`, "utf8");
}

if (scenario === "duplicate") {
  const timestamp = "2026-11-19T10:00:00.000Z";
  globalThis.Date = new Proxy(Date, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [timestamp] : args, newTarget);
    },
  });
  const evidence = buildGateRunEvidence({
    repoRoot: root,
    gateId: "G0.5",
    checkedAt: timestamp,
    sessionId: process.env.UT_TDD_SESSION_ID,
    status: "passed",
  });
  const digest = createHash("sha256").update(evidence.gate_run_id, "utf8").digest("hex");
  const final = join(directory, `${digest}.json`);
  const initial = `${JSON.stringify(evidence)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  writeFileSync(final, initial, { flag: "wx" });
  record({ kind: "seed", final, initial });
  fs.readFileSync = (path, ...args) => {
    const bytes = readFileSync(path, ...args);
    if (path === final) record({ kind: "read", final });
    return bytes;
  };
}

fs.writeFileSync = (path, ...args) => {
  const result = writeFileSync(path, ...args);
  if (isStage(path)) record({ kind: "stage", staged: path });
  return result;
};

fs.linkSync = (staged, final) => {
  if (dirname(final) !== directory) return linkSync(staged, final);
  record({ kind: "link", staged, final });
  if (scenario === "unsupported") {
    const error = Object.assign(new Error("fixture link failure: ENOTSUP"), { code: "ENOTSUP" });
    record({ kind: "link-error", code: error.code });
    throw error;
  }
  if (scenario === "occupied") {
    const initial = '{"fixture":"occupied during link"}\n';
    writeFileSync(final, initial, { flag: "wx" });
    record({ kind: "seed", final, initial });
  }
  try {
    return linkSync(staged, final);
  } catch (error) {
    record({ kind: "link-error", code: error.code });
    throw error;
  }
};

syncBuiltinESMExports();
