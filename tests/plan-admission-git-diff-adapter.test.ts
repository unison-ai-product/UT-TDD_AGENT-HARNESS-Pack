import { describe, expect, it } from "vitest";
import {
  type GitCommandPort,
  type GitDiffAdapterError,
  type GitDiffAdapterErrorCode,
  readAdmissionGitDiff,
} from "../src/plan-admission/git-diff-adapter.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const encoder = new TextEncoder();

class FakeGit implements GitCommandPort {
  private readonly diff: Uint8Array;
  private readonly blobs: ReadonlyMap<string, Uint8Array>;

  constructor(diff: Uint8Array, blobs: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.diff = diff;
    this.blobs = blobs;
  }

  run(args: readonly string[]): Uint8Array {
    if (args[0] === "rev-parse")
      return encoder.encode(args.at(-1)?.startsWith("base") ? `${BASE}\n` : `${HEAD}\n`);
    if (args[0] === "diff") return this.diff;
    const key = args[1];
    const blob = key ? this.blobs.get(key) : undefined;
    if (!blob) throw new Error(`missing fixture ${key}`);
    return blob;
  }
}

function nul(...fields: string[]): Uint8Array {
  return encoder.encode(`${fields.join("\0")}\0`);
}

describe("readAdmissionGitDiff", () => {
  it("NUL区切りの変更とrename両側のblobを読み込む", () => {
    const oldPath = "docs/plans/PLAN-L7-900-old.md";
    const newPath = "docs/plans/PLAN-L7-900-new.md";
    const modified = "docs/plans/PLAN-L7-901-modified.md";
    const blobs = new Map([
      [`${BASE}:${oldPath}`, encoder.encode("old")],
      [`${HEAD}:${newPath}`, encoder.encode("new")],
      [`${BASE}:${modified}`, encoder.encode("before")],
      [`${HEAD}:${modified}`, encoder.encode("after")],
    ]);
    const result = readAdmissionGitDiff({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(nul("R100", oldPath, newPath, "M", modified), blobs),
    });

    expect(result.changes).toEqual([
      { kind: "renamed", from: oldPath, path: newPath },
      { kind: "modified", path: modified },
    ]);
    expect(result.base).toEqual([
      { path: oldPath, content: "old" },
      { path: modified, content: "before" },
    ]);
    expect(result.head).toEqual([
      { path: newPath, content: "new" },
      { path: modified, content: "after" },
    ]);
  });

  it("plan領域からのrename流出を削除としてfail-close対象にする", () => {
    const path = "docs/plans/PLAN-L7-902-moved.md";
    const blobs = new Map([[`${BASE}:${path}`, encoder.encode("old")]]);
    const result = readAdmissionGitDiff({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(nul("R100", path, "docs/archive/PLAN-L7-902-moved.md"), blobs),
    });
    expect(result.changes).toEqual([{ kind: "deleted", path }]);
    expect(result.base).toEqual([{ path, content: "old" }]);
  });

  it.each<readonly [Uint8Array, GitDiffAdapterErrorCode]>([
    [
      nul("C100", "docs/plans/PLAN-L7-903-a.md", "docs/plans/PLAN-L7-903-b.md"),
      "git-status-unknown",
    ],
    [nul("M", "docs/plans/../plans/PLAN-L7-903-a.md"), "git-path-invalid"],
    [encoder.encode("M\0docs/plans/PLAN-L7-903-a.md"), "git-diff-malformed"],
  ])("未知status・非canonical path・壊れたNUL列を拒否する", (diff, code) => {
    expect(() =>
      readAdmissionGitDiff({ baseRef: "base", headRef: "head", git: new FakeGit(diff) }),
    ).toThrowError(expect.objectContaining<Partial<GitDiffAdapterError>>({ code }));
  });

  it("欠落blobと不正UTF-8 blobを区別して拒否する", () => {
    const path = "docs/plans/PLAN-L7-904-added.md";
    const diff = nul("A", path);
    expect(() =>
      readAdmissionGitDiff({ baseRef: "base", headRef: "head", git: new FakeGit(diff) }),
    ).toThrowError(expect.objectContaining({ code: "git-blob-missing" }));
    const blobs = new Map([[`${HEAD}:${path}`, Uint8Array.from([0xc3, 0x28])]]);
    expect(() =>
      readAdmissionGitDiff({ baseRef: "base", headRef: "head", git: new FakeGit(diff, blobs) }),
    ).toThrowError(expect.objectContaining({ code: "git-blob-invalid-utf8" }));
  });
});
