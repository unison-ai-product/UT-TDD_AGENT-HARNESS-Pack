import { writeSync } from "node:fs";
import { buildGateRunEvidence, writeGateRunEvidence } from "../../src/gate/run-evidence.ts";

const hold = process.argv[2] === "hold";
const input = {
  repoRoot: process.cwd(),
  gateId: "G0.5",
  status: "passed",
  checkedAt: hold ? "2026-11-19T10:00:00.000Z" : "2026-11-19T10:00:01.000Z",
  sessionId: "gate-publish-crash-fixture",
};
const report = (entry) => writeSync(1, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const boundary = hold
  ? {
      beforeLink(staged, final) {
        report({ kind: "before-link", staged, final, evidence: buildGateRunEvidence(input) });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        throw new Error("parent did not terminate the fixture");
      },
    }
  : undefined;
const written = writeGateRunEvidence(input, boundary);
report({ kind: "published", written });
