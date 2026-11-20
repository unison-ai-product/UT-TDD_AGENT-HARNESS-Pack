import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluateClaudeVersion, readTranscriptClaudeVersion } from "./claude-version-check.ts";
import { CLAUDE_CODE_VERSION_FLOOR } from "./claude-version-floor.ts";

export function emitClaudeVersionWarning(
  repoRoot: string,
  sessionId: string,
  transcriptPath: string | undefined,
): boolean {
  if (
    process.env.CLAUDECODE !== "1" ||
    process.env.CODEX_SANDBOX !== undefined ||
    process.env.CODEX_HOME !== undefined
  ) {
    return false;
  }

  const marker = join(
    repoRoot,
    ".ut-tdd",
    "state",
    "claude-version-warning",
    `${createHash("sha256").update(sessionId).digest("hex")}.seen`,
  );
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "warned\n", { flag: "wx" });
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unknown_error";
    if (errorCode === "EEXIST") {
      return false;
    }
    process.stderr.write(`claude-version-warning: marker save failed (${errorCode})\n`);
  }

  const version = readTranscriptClaudeVersion(transcriptPath);
  if (evaluateClaudeVersion(version) === "ok") return false;

  const message = version
    ? `Claude Code ${version} is below the supported floor ${CLAUDE_CODE_VERSION_FLOOR}. Guard hooks' onFailure: "block" is ignored by this version, so writes may not be blocked when a guard fails. Update Claude Code.`
    : `Claude Code の版を確かめられないため、guard hooks' onFailure: "block" による失敗時停止を確認できません。Claude Code ${CLAUDE_CODE_VERSION_FLOOR} 以降へ更新してください。`;
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  return true;
}
