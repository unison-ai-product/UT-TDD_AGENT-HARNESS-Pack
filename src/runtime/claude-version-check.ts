import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CLAUDE_CODE_VERSION_FLOOR } from "./claude-version-floor.ts";

function versionParts(version: string | null): bigint[] | null {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return version.split(".").map((part) => BigInt(part));
}

export function evaluateClaudeVersion(version: string | null): "ok" | "below" | "unknown" {
  const actual = versionParts(version);
  const floor = versionParts(CLAUDE_CODE_VERSION_FLOOR);
  if (!actual || !floor) return "unknown";

  for (let index = 0; index < floor.length; index += 1) {
    const actualPart = actual[index] ?? 0n;
    const floorPart = floor[index] ?? 0n;
    if (actualPart < floorPart) return "below";
    if (actualPart > floorPart) return "ok";
  }
  return "ok";
}

// L6 claude-version-probe §5: 末尾の 4 MiB だけを 1 回で読む。
const TRANSCRIPT_TAIL_BYTES = 4_194_304;

function readTranscriptTail(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    let tail = buffer.subarray(0, filled);
    if (start > 0) {
      // 途中から (または行の先頭ちょうどから) 始まる最初の行は読まない。
      const newline = tail.indexOf(0x0a);
      if (newline < 0) return null;
      tail = tail.subarray(newline + 1);
    }
    return tail.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readTranscriptClaudeVersion(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  try {
    const text = readTranscriptTail(transcriptPath);
    if (text === null) return null;
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const row = JSON.parse(line) as { type?: unknown; version?: unknown };
      if (row.type !== "user" && row.type !== "assistant") continue;
      return typeof row.version === "string" && versionParts(row.version) ? row.version : null;
    }
  } catch {
    return null;
  }
  return null;
}
