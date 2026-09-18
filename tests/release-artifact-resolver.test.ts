import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseIdentity } from "../src/schema/release-manifest.ts";
import {
  createLocalGitObjectReader,
  type GitProcessRequest,
  type GitProcessResult,
  type LocalGitObjectReader,
  resolveReleaseArtifacts,
} from "../src/setup/release-artifact-resolver.ts";
import type {
  ReleaseMaterializationResult,
  ReleaseSourceEntry,
} from "../src/setup/release-materializer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const release = (commit: string, version = "1"): ReleaseIdentity => ({
  releaseId: `rel-sha256:${"1".repeat(64)}`,
  materializerVersion: version,
  artifactSourceCommit: commit,
  artifactSetDigest: `sha256:${"2".repeat(64)}`,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): { root: string; v1: string; v2: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-pf3-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, "artifact.txt"), "v1\0bytes");
  git(root, "add", "artifact.txt");
  git(root, "commit", "-qm", "v1");
  const v1 = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "artifact.txt"), "v2-bytes");
  git(root, "commit", "-qam", "v2");
  const v2 = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "control.txt"), "control");
  git(root, "add", "control.txt");
  git(root, "commit", "-qm", "control");
  return { root, v1, v2, head: git(root, "rev-parse", "HEAD") };
}

function materializerSpy() {
  return vi.fn(
    async (input: {
      materializerVersion: unknown;
      entries: readonly ReleaseSourceEntry[];
    }): Promise<ReleaseMaterializationResult> => ({
      ok: true as const,
      entries: input.entries,
      digest: `sha256:${"3".repeat(64)}`,
    }),
  );
}

function treeRecord(
  path: Uint8Array | string,
  mode = "100644",
  type = "blob",
  oid = "a".repeat(40),
  terminated = true,
): Uint8Array {
  return Buffer.concat([
    Buffer.from(`${mode} ${type} ${oid}\t`),
    typeof path === "string" ? Buffer.from(path) : Buffer.from(path),
    ...(terminated ? [Buffer.from([0])] : []),
  ]);
}

function reader(overrides: Partial<LocalGitObjectReader> = {}): LocalGitObjectReader {
  return {
    hasCommit: vi.fn(async () => ({ ok: true as const })),
    listTree: vi.fn(async () => ({ ok: true as const, records: treeRecord("a.txt") })),
    readBlobs: vi.fn(async (_repository: string, oids: readonly string[]) => ({
      ok: true as const,
      blobs: new Map(oids.map((oid) => [oid, Buffer.from("blob")])) as ReadonlyMap<
        string,
        Uint8Array
      >,
    })),
    ...overrides,
  };
}

describe("U-RELMAN-012", () => {
  it("異なるrelease revisionだけを解決しcontrol HEADを判定に使わない", async () => {
    const repo = repository();
    expect(repo.head).not.toBe(repo.v1);
    expect(repo.head).not.toBe(repo.v2);
    const materialize = materializerSpy();
    const dependencies = { git: createLocalGitObjectReader(), materialize };
    const stable = await resolveReleaseArtifacts(
      { repository: repo.root, release: release(repo.v1) },
      dependencies,
    );
    const canary = await resolveReleaseArtifacts(
      { repository: repo.root, release: release(repo.v2) },
      dependencies,
    );
    expect(
      stable.ok &&
        Buffer.from(
          stable.entries.find((e) => e.path === "artifact.txt")?.content ?? [],
        ).toString(),
    ).toBe("v1\0bytes");
    expect(
      canary.ok &&
        Buffer.from(
          canary.entries.find((e) => e.path === "artifact.txt")?.content ?? [],
        ).toString(),
    ).toBe("v2-bytes");
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize.mock.calls.map(([input]) => input.materializerVersion)).toEqual(["1", "1"]);
  });

  it("missing commitとpartial clone missing blobはunavailableでmaterializerを呼ばない", async () => {
    const repo = repository();
    const materialize = materializerSpy();
    const missing = await resolveReleaseArtifacts(
      { repository: repo.root, release: release("f".repeat(40)) },
      { git: createLocalGitObjectReader(), materialize },
    );
    expect(missing).toEqual({ ok: false, error: "unavailable" });
    expect(materialize).not.toHaveBeenCalled();

    const bare = `${repo.root}-bare`;
    const clone = `${repo.root}-partial`;
    roots.push(bare, clone);
    git(repo.root, "clone", "--bare", ".", bare);
    git(bare, "config", "uploadpack.allowFilter", "true");
    execFileSync("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      `file:///${bare.replace(/\\/g, "/")}`,
      clone,
    ]);
    const revision = git(clone, "rev-parse", "HEAD");
    const missingOid = git(repo.root, "rev-parse", `${revision}:artifact.txt`);
    const missingObjects = () =>
      execFileSync("git", ["rev-list", "--objects", "--missing=print", revision], {
        cwd: clone,
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      });
    expect(missingObjects()).toContain(`?${missingOid}`);
    expect(git(bare, "rev-parse", "HEAD")).toBe(revision);
    const trace = join(tmpdir(), `ut-pf3-trace-${process.pid}-${Date.now()}.json`);
    roots.push(trace);
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    const partialMaterialize = materializerSpy();
    const partial = await resolveReleaseArtifacts(
      { repository: clone, release: release(revision) },
      { git: createLocalGitObjectReader(), materialize: partialMaterialize },
    );
    expect(partial).toEqual({ ok: false, error: "unavailable" });
    expect(partialMaterialize).not.toHaveBeenCalled();
    expect(missingObjects()).toContain(`?${missingOid}`);
    expect(git(bare, "rev-parse", "HEAD")).toBe(revision);
    expect(readFileSync(trace, "utf8")).not.toMatch(/"child_class":"fetch"/);
  });

  it("tree列挙後のblob欠落もunavailableで全entry完成前にmaterializeしない", async () => {
    const materialize = materializerSpy();
    const result = await resolveReleaseArtifacts(
      { repository: "repo", release: release("a".repeat(40)) },
      {
        git: reader({
          readBlobs: vi.fn(async () => ({ ok: false as const, error: "unavailable" as const })),
        }),
        materialize,
      },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it.each([
    "d".repeat(39),
    "D".repeat(40),
    ` ${"d".repeat(40)}`,
    `${"d".repeat(40)} `,
  ])("revision token %jをtrim/coerceせずunavailableへ倒す", async (revision) => {
    const gitReader = reader();
    const result = await resolveReleaseArtifacts(
      { repository: "repo", release: release(revision) },
      { git: gitReader, materialize: materializerSpy() },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(gitReader.hasCommit).not.toHaveBeenCalled();
  });

  it("regular/executable/symlinkのpath、mode、raw bytesを保持する", async () => {
    const records = Buffer.concat([
      treeRecord("regular", "100644", "blob", "a".repeat(40)),
      treeRecord("executable", "100755", "blob", "b".repeat(40)),
      treeRecord("link", "120000", "blob", "c".repeat(40)),
    ]);
    const blobs = new Map([
      ["a".repeat(40), Buffer.from([0, 1])],
      ["b".repeat(40), Buffer.from([2, 0])],
      ["c".repeat(40), Buffer.from("../target")],
    ]);
    const materialize = materializerSpy();
    await resolveReleaseArtifacts(
      { repository: "repo", release: release("d".repeat(40)) },
      {
        git: reader({
          listTree: vi.fn(async () => ({ ok: true as const, records })),
          readBlobs: vi.fn(async () => ({ ok: true as const, blobs })),
        }),
        materialize,
      },
    );
    expect(
      materialize.mock.calls[0][0].entries.map((entry) => ({
        ...entry,
        content: [...entry.content],
      })),
    ).toEqual([
      { path: "regular", mode: "100644", content: [...(blobs.get("a".repeat(40)) ?? [])] },
      { path: "executable", mode: "100755", content: [...(blobs.get("b".repeat(40)) ?? [])] },
      { path: "link", mode: "120000", content: [...(blobs.get("c".repeat(40)) ?? [])] },
    ]);
  });

  it.each([
    ["NUL未終端", treeRecord("a", "100644", "blob", "a".repeat(40), false)],
    [
      "duplicate path",
      Buffer.concat([treeRecord("a"), treeRecord("a", "100644", "blob", "b".repeat(40))]),
    ],
    ["tree type", treeRecord("a", "040000", "tree")],
    ["unsupported mode", treeRecord("a", "100600")],
    ["invalid UTF-8", treeRecord(new Uint8Array([0xff]))],
    ["field欠損", Buffer.from("broken\0")],
  ])("不正tree record (%s)をinvalid_artifactへ倒す", async (_name, records) => {
    const materialize = materializerSpy();
    const result = await resolveReleaseArtifacts(
      { repository: "repo", release: release("d".repeat(40)) },
      {
        git: reader({ listTree: vi.fn(async () => ({ ok: true as const, records })) }),
        materialize,
      },
    );
    expect(result).toEqual({ ok: false, error: "invalid_artifact" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("同一blob OIDは1回だけ読みentryは2 pathとも保持する", async () => {
    const oid = "a".repeat(40);
    const readBlobs = vi.fn(async (_repository: string, _oids: readonly string[]) => ({
      ok: true as const,
      blobs: new Map([[oid, Buffer.from("shared")]]),
    }));
    const materialize = materializerSpy();
    await resolveReleaseArtifacts(
      { repository: "repo", release: release("d".repeat(40)) },
      {
        git: reader({
          listTree: vi.fn(async () => ({
            ok: true as const,
            records: Buffer.concat([
              treeRecord("a", "100644", "blob", oid),
              treeRecord("b", "100755", "blob", oid),
            ]),
          })),
          readBlobs,
        }),
        materialize,
      },
    );
    expect(readBlobs).toHaveBeenCalledWith("repo", [oid]);
    expect(materialize.mock.calls[0][0].entries.map((entry) => entry.path)).toEqual(["a", "b"]);
  });

  it.each([
    "unavailable",
    "invalid_distribution_plan",
    "invalid_artifact",
  ] as const)("materializer error %sを保持する", async (error) => {
    const result = await resolveReleaseArtifacts(
      { repository: "repo", release: release("d".repeat(40)) },
      { git: reader(), materialize: vi.fn(async () => ({ ok: false as const, error })) },
    );
    expect(result).toEqual({ ok: false, error });
  });

  it.each([
    "hasCommit",
    "listTree",
    "readBlobs",
    "materialize",
  ] as const)("%s portのthrow/rejectをunavailableへfail-closeする", async (throwingPort) => {
    const gitReader = reader(
      throwingPort === "materialize"
        ? {}
        : { [throwingPort]: vi.fn(async () => Promise.reject(new Error("injected"))) },
    );
    const materialize =
      throwingPort === "materialize"
        ? vi.fn(async () => Promise.reject(new Error("injected")))
        : materializerSpy();
    await expect(
      resolveReleaseArtifacts(
        { repository: "repo", release: release("d".repeat(40)) },
        { git: gitReader, materialize },
      ),
    ).resolves.toEqual({ ok: false, error: "unavailable" });
  });

  it.each([
    ["missing", `${"a".repeat(40)} missing\n`, 0],
    ["OID不一致", `${"b".repeat(40)} blob 1\nx\n`, 0],
    ["type不一致", `${"a".repeat(40)} tree 1\nx\n`, 0],
    ["non-canonical size", `${"a".repeat(40)} blob 01\nx\n`, 0],
    ["unsafe size", `${"a".repeat(40)} blob 9007199254740992\n`, 0],
    ["short payload", `${"a".repeat(40)} blob 4\nabc\n`, 0],
    ["extra byte", `${"a".repeat(40)} blob 1\nx\nextra`, 0],
    ["payload LF欠落", `${"a".repeat(40)} blob 1\nx`, 0],
    ["nonzero exit", `${"a".repeat(40)} blob 1\nx\n`, 1],
  ])("batch %sをunavailableへ倒す", async (_name, stdout, exitCode) => {
    const objectReader = createLocalGitObjectReader({
      run: vi.fn(async () => ({ exitCode, stdout: Buffer.from(stdout) })),
    });
    await expect(objectReader.readBlobs("repo", ["a".repeat(40)])).resolves.toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it.each([1, 41, 48, 49, 50])("batch chunk境界 %i でもbinary payloadを保持する", async (split) => {
    const oid = "a".repeat(40);
    const payload = Buffer.from([0, 1, 0, 2]);
    const output = Buffer.concat([
      Buffer.from(`${oid} blob ${payload.length}\n`),
      payload,
      Buffer.from("\n"),
    ]);
    const objectReader = createLocalGitObjectReader({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: output,
        stdoutChunks: [output.subarray(0, split), output.subarray(split)],
      })),
    });
    const result = await objectReader.readBlobs("repo", [oid]);
    expect(result.ok && [...(result.blobs.get(oid) ?? [])]).toEqual([...payload]);
  });

  it("Git argv/env/import境界と2MiB超binary batch framingを固定する", async () => {
    const oid = "a".repeat(40);
    const large = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
    large[1024] = 0;
    const calls: GitProcessRequest[] = [];
    for (const key of [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_WORK_TREE",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "git_config_key_1",
    ])
      vi.stubEnv(key, "attacker-controlled");
    const runner = vi.fn(async (request: GitProcessRequest): Promise<GitProcessResult> => {
      calls.push(request);
      if (request.args[0] === "cat-file" && request.args[1] === "-e")
        return { exitCode: 0, stdout: new Uint8Array() };
      if (request.args[0] === "ls-tree")
        return { exitCode: 0, stdout: treeRecord("large.bin", "100644", "blob", oid) };
      return {
        exitCode: 0,
        stdout: Buffer.concat([
          Buffer.from(`${oid} blob ${large.length}\n`),
          large,
          Buffer.from("\n"),
        ]),
      };
    });
    const materialize = materializerSpy();
    await resolveReleaseArtifacts(
      { repository: "repo", release: release("d".repeat(40)) },
      { git: createLocalGitObjectReader({ run: runner }), materialize },
    );
    expect(Buffer.from(materialize.mock.calls[0][0].entries[0].content)).toEqual(large);
    expect(calls.map((call) => call.args)).toEqual([
      ["cat-file", "-e", `${"d".repeat(40)}^{commit}`],
      ["ls-tree", "-r", "-z", "--full-tree", "d".repeat(40)],
      ["cat-file", "--batch"],
    ]);
    expect(
      calls.every(
        (call) =>
          call.env.GIT_NO_LAZY_FETCH === "1" &&
          call.env.GIT_TERMINAL_PROMPT === "0" &&
          call.env.GIT_NO_REPLACE_OBJECTS === "1",
      ),
    ).toBe(true);
    expect(
      calls.every((call) =>
        Object.keys(call.env).every((key) => {
          const name = key.toUpperCase();
          return (
            ![
              "GIT_DIR",
              "GIT_COMMON_DIR",
              "GIT_OBJECT_DIRECTORY",
              "GIT_ALTERNATE_OBJECT_DIRECTORIES",
              "GIT_WORK_TREE",
              "GIT_CONFIG",
            ].includes(name) && !name.startsWith("GIT_CONFIG_")
          );
        }),
      ),
    ).toBe(true);
    expect(calls[2].stdin).toEqual(Buffer.from(`${oid}\n`));
    const source = readFileSync(
      join(process.cwd(), "src/setup/release-artifact-resolver.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']node:fs/);
    expect(source).not.toMatch(/from ["'][^"']*(?:network|distribution|sync|apply)/);
    expect(source).toContain('child.stdin.on("error"');
  });

  it("default Git process runnerも2MiB超binaryを全量stdout複製せず解決する", async () => {
    const repo = repository();
    const large = Buffer.alloc(2 * 1024 * 1024 + 17, 0x62);
    large[1024] = 0;
    writeFileSync(join(repo.root, "large.bin"), large);
    git(repo.root, "add", "large.bin");
    git(repo.root, "commit", "-qm", "large binary");
    const revision = git(repo.root, "rev-parse", "HEAD");
    const materialize = materializerSpy();

    const result = await resolveReleaseArtifacts(
      { repository: repo.root, release: release(revision) },
      { git: createLocalGitObjectReader(), materialize },
    );

    expect(result.ok).toBe(true);
    const entry = materialize.mock.calls[0][0].entries.find(({ path }) => path === "large.bin");
    expect(Buffer.from(entry?.content ?? [])).toEqual(large);
  });
});
