import "../src/runtime/windows-hide.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOracleBaselineRatchet } from "../src/lint/oracle-test-trace.ts";

const repoRoot = process.env.GITHUB_WORKSPACE;
const baselinePath = "docs/governance/oracle-test-trace-baseline.json";
const oracleTraceGitPaths = new Set([
  baselinePath,
  "src/lint/oracle-test-trace-baseline.ts",
  "src/lint/oracle-test-trace-widened-baseline.ts",
  "src/lint/oracle-test-citation-baseline.ts",
]);
const sourceModule = fileURLToPath(import.meta.resolve("../src/lint/oracle-test-trace.ts"));
const moduleRoot = resolve(dirname(sourceModule), "../..");
const decodeUtf8 = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const gitBytes = (args) => {
  if (!repoRoot) throw new Error("github_workspace_missing");
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
};
const gitText = (args) => decodeUtf8(gitBytes(args));
const authority = {
  readText(path) {
    if (path !== baselinePath) return { ok: false, reason: "authority_read_failed" };
    try {
      return { ok: true, value: decodeUtf8(readFileSync(resolve(moduleRoot, path))) };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT")
        return { ok: true, value: null };
      return { ok: false, reason: "authority_read_failed" };
    }
  },
};
const git = {
  readFirstParent(mergeSha) {
    try {
      const commit = gitText(["cat-file", "-p", mergeSha]);
      const headers = commit.split(/\r?\n\r?\n/u, 1)[0] ?? "";
      const parent = headers.split(/\r?\n/u).find((line) => line.startsWith("parent "));
      if (!parent) return { ok: true, value: null };
      const parentSha = parent.slice("parent ".length);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parentSha))
        return { ok: false, reason: "git_first_parent_read_failed" };
      return { ok: true, value: parentSha };
    } catch {
      return { ok: false, reason: "git_first_parent_read_failed" };
    }
  },
  readTextAt(commitSha, path) {
    if (!oracleTraceGitPaths.has(path)) return { ok: false, reason: "git_object_read_failed" };
    try {
      const records = gitText(["ls-tree", "-z", "--full-tree", commitSha, "--", path])
        .split("\0")
        .filter(Boolean);
      if (records.length === 0) return { ok: true, value: null };
      if (records.length !== 1) return { ok: false, reason: "git_object_read_failed" };
      const entry = /^(?:100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(records[0]);
      if (!entry || entry[2] !== path) return { ok: false, reason: "git_object_read_failed" };
      return { ok: true, value: gitText(["cat-file", "blob", entry[1]]) };
    } catch {
      return { ok: false, reason: "git_object_read_failed" };
    }
  },
};
const result = checkOracleBaselineRatchet({
  authority,
  ci: {
    eventName: process.env.ORACLE_RATCHET_EVENT_NAME ?? "",
    mergeSha: process.env.ORACLE_RATCHET_MERGE_SHA ?? "",
    git,
  },
});
if (!result.ok) {
  console.error(`checkOracleBaselineRatchet: ${result.reason}`);
  process.exitCode = 1;
}
