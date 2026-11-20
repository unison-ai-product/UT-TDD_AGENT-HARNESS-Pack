import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readTranscriptClaudeVersion } from "../src/runtime/claude-version-check.ts";
import { makeFixtureDir } from "./support/claude-probe-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const counters = vi.hoisted(() => ({ readBytes: 0, whole: 0 }));

type Fs = typeof import("node:fs");
function wrapFs(actual: Fs): Fs {
  const any = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      const n = any.readSync?.(...args) as number;
      counters.readBytes += n;
      return n;
    },
    readFileSync: (...args: unknown[]) => {
      counters.whole += 1;
      return any.readFileSync?.(...args);
    },
    readFile: (...args: unknown[]) => {
      counters.whole += 1;
      return any.readFile?.(...args);
    },
    createReadStream: (...args: unknown[]) => {
      counters.whole += 1;
      return any.createReadStream?.(...args);
    },
  } as unknown as Fs;
}
vi.mock("node:fs", async (importOriginal) => wrapFs(await importOriginal<Fs>()));
vi.mock("fs", async (importOriginal) => wrapFs(await importOriginal<Fs>()));

const ROOT = makeFixtureDir();
afterAll(() => removeTestTree(ROOT));

function paddedLine(head: string, total: number): string {
  const tail = '"}\n';
  return `${head}${"x".repeat(total - head.length - tail.length)}${tail}`;
}

// 016 と同じ transcript (R の先頭から末尾までが 4,194,304 bytes = 200 + 63 * 65,536 + 65,336)。
function writeTranscript016(): string {
  const progress = (n: number) => paddedLine('{"type":"progress","pad":"', n);
  const rows = [progress(5_000), paddedLine('{"type":"user","version":"2.1.293","pad":"', 200)];
  for (let i = 0; i < 63; i += 1) rows.push(progress(65_536));
  rows.push(progress(65_336));
  const path = join(ROOT, "t021.jsonl");
  writeFileSync(path, rows.join(""));
  return path;
}

const transcript = writeTranscript016();
const preconditionHolds = readTranscriptClaudeVersion(transcript) === null;

describe("Claude Code transcript read amount (Issue #1676)", () => {
  beforeEach(() => {
    counters.readBytes = 0;
    counters.whole = 0;
  });

  it.skipIf(!preconditionHolds)(
    "CANDIDATE-U-CCVER-021 reads at most 4 MiB with readSync and never the whole file",
    () => {
      expect(readTranscriptClaudeVersion(transcript)).toBeNull();
      expect(counters.readBytes).toBeLessThanOrEqual(4_194_304);
      expect(counters.whole).toBe(0);
    },
  );
});
