import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkBaselineConflictWithPreview } from "../../src/feedback/baseline-conflict.ts";

const [repoRoot, headSha, barrierRoot, workerId] = process.argv.slice(2);
if (!repoRoot || !headSha || !barrierRoot || !workerId) {
  throw new Error("usage: baseline-preview-concurrent-worker <repoRoot> <headSha> <barrier> <id>");
}

let previewRoot = "";
const result = checkBaselineConflictWithPreview(repoRoot, headSha, {
  pr: 1559,
  gates: [
    {
      name: "code-size",
      inScope: (path) => path === "src/alpha.ts",
      baselinePath: "docs/governance/small-baseline.json",
      check: (root) => {
        previewRoot = root;
        if (existsSync(join(root, "node_modules"))) {
          throw new Error("preview worktree must not contain a node_modules link");
        }
        writeFileSync(join(barrierRoot, `ready-${workerId}`), root, "utf8");
        const deadline = Date.now() + 60_000;
        while (!existsSync(join(barrierRoot, "release"))) {
          if (Date.now() >= deadline) throw new Error("preview concurrency barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        return { ok: true, findings: [] };
      },
    },
  ],
});

process.stdout.write(`${JSON.stringify({ result, previewRoot })}\n`);
