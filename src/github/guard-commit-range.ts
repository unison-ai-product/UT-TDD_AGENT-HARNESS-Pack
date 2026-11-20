import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  evaluateGithubOpsGuard,
  type GithubOpsGuardInput,
  type GithubOpsGuardResult,
} from "./ops-guard.ts";

type CommitInputError = {
  code: "commit-file-unavailable" | "commit-range-unavailable";
  evidence: string;
  message: string;
};

type CommitSubjects = { subjects: string[]; error?: CommitInputError };

function markEmptySubjects(subjects: string[]): string[] {
  return subjects.map((subject) =>
    subject.trim().length === 0 ? "<empty commit subject>" : subject,
  );
}

export function parseCommitFileSubjects(contents: string): string[] {
  if (contents.length === 0) return [];
  const subjects = contents.split(/\r?\n/);
  if (subjects.at(-1) === "") subjects.pop();
  return markEmptySubjects(subjects);
}

export function parseGitLogSubjects(output: string): string[] {
  if (output.length === 0) return [];
  const records = output.split("\0");
  const trailing = records.pop();
  if (trailing !== "\n" && trailing !== "\r\n") {
    throw new Error("git log returned an unterminated commit subject stream");
  }
  const subjects = records.map((record, index) =>
    index === 0 ? record : record.replace(/^\r?\n/, ""),
  );
  return markEmptySubjects(subjects);
}

function resolveCommitSubjects(input: {
  baseRef: string;
  commitFile?: string;
  cwd: string;
}): CommitSubjects {
  if (input.commitFile !== undefined) {
    try {
      return {
        subjects: parseCommitFileSubjects(readFileSync(input.commitFile, "utf8")),
      };
    } catch (error) {
      return {
        subjects: [],
        error: {
          code: "commit-file-unavailable",
          evidence: input.commitFile,
          message: `could not read explicit commit subject file ${input.commitFile}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  const preferredBase = input.baseRef.startsWith("origin/")
    ? input.baseRef
    : `origin/${input.baseRef}`;
  const candidates = [...new Set([preferredBase, input.baseRef])];
  let resolvedBase: string | undefined;
  for (const ref of candidates) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: input.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      resolvedBase = ref;
      break;
    } catch {
      // An absent origin ref is expected outside checkouts with remotes; try the local base.
    }
  }

  if (!resolvedBase) {
    return {
      subjects: [],
      error: {
        code: "commit-range-unavailable",
        evidence: input.baseRef,
        message: `could not resolve origin/${input.baseRef} or ${input.baseRef} as a commit`,
      },
    };
  }

  try {
    const output = execFileSync("git", ["log", "--format=%s%x00", `${resolvedBase}..HEAD`], {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { subjects: parseGitLogSubjects(output) };
  } catch (error) {
    return {
      subjects: [],
      error: {
        code: "commit-range-unavailable",
        evidence: input.baseRef,
        message: `could not read commit subjects from ${resolvedBase}..HEAD: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}

export function evaluateGithubOpsGuardWithCommitInput(
  input: GithubOpsGuardInput & { commitFile?: string; cwd: string },
): GithubOpsGuardResult {
  const commitInput = resolveCommitSubjects(input);
  const evaluated = evaluateGithubOpsGuard({ ...input, commitSubjects: commitInput.subjects });
  if (!commitInput.error) return evaluated;

  return {
    ...evaluated,
    ok: false,
    findings: [...evaluated.findings, { ...commitInput.error, severity: "error" }],
  };
}
