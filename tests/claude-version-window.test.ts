import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTranscriptClaudeVersion } from "../src/runtime/claude-version-check.ts";
import { makeFixtureDir } from "./support/claude-probe-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const ROOT = makeFixtureDir();
afterAll(() => removeTestTree(ROOT));

/** 改行を含めてちょうど total bytes の 1 行を作る。 */
function paddedLine(head: string, total: number): string {
  const tail = '"}\n';
  const pad = total - head.length - tail.length;
  if (pad < 0) throw new Error("line too short");
  return `${head}${"x".repeat(pad)}${tail}`;
}
const progress = (total: number) => paddedLine('{"type":"progress","pad":"', total);

/** L7 §2: 5,000 bytes の非 message 行、R (200 bytes)、非 message 行。R の先頭から末尾までが tailBytes。 */
function writeTranscript(name: string, tailBytes: number): string {
  const rows = [progress(5_000), paddedLine('{"type":"user","version":"2.1.293","pad":"', 200)];
  let rest = tailBytes - 200;
  while (rest > 0) {
    // 65,536 bytes の行を並べ、最後の 1 行で端数を合わせる (端数が短すぎないよう手前で調整)。
    const size = rest >= 65_536 + 64 || rest === 65_536 ? 65_536 : rest;
    rows.push(progress(size));
    rest -= size;
  }
  const path = join(ROOT, name);
  writeFileSync(path, rows.join(""));
  return path;
}

describe("Claude Code transcript tail window (Issue #1676)", () => {
  it("CANDIDATE-U-CCVER-016 drops a line that starts exactly at the window start", () => {
    expect(readTranscriptClaudeVersion(writeTranscript("t016.jsonl", 4_194_304))).toBeNull();
  });

  it("CANDIDATE-U-CCVER-017 reads a line that starts one byte inside the window", () => {
    expect(readTranscriptClaudeVersion(writeTranscript("t017.jsonl", 4_194_303))).toBe("2.1.293");
  });
});
