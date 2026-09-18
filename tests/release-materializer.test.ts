import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCleanDistributionPlan,
  cleanDistributionArtifactPath,
  cleanDistributionSourcePath,
  transformCleanDistributionArtifact,
} from "../src/setup/distribution.ts";
import {
  materializeReleaseArtifacts,
  type ReleaseSourceEntry,
} from "../src/setup/release-materializer.ts";

const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");
const required = buildCleanDistributionPlan({ paths: [] }).missingRequired;

function fixture(extra: ReleaseSourceEntry[] = []): ReleaseSourceEntry[] {
  return [
    ...required.map((path) => ({
      path,
      mode: "100644" as const,
      content: bytes(
        path === "package.json" ? '{"name":"fixture","scripts":{"test":"vitest run"}}' : path,
      ),
    })),
    ...extra,
  ];
}

function ok(entries = fixture()) {
  const result = materializeReleaseArtifacts({ materializerVersion: "1", entries });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function digest(entries: readonly { path: string; mode: string; content: Uint8Array }[]): string {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const path = Buffer.from(entry.path);
    const mode = Buffer.from(entry.mode, "ascii");
    const pathLength = Buffer.alloc(4);
    const modeLength = Buffer.alloc(4);
    const contentLength = Buffer.alloc(8);
    pathLength.writeUInt32BE(path.length);
    modeLength.writeUInt32BE(mode.length);
    contentLength.writeBigUInt64BE(BigInt(entry.content.length));
    chunks.push(pathLength, path, modeLength, mode, contentLength, Buffer.from(entry.content));
  }
  return `sha256:${createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}`;
}

describe("U-RELMAN-011 versioned release materializer", () => {
  it("同じ入力の dry-run/apply 相当2呼出しは byte-identical snapshot になる", () => {
    const input = fixture([{ path: "src/a.ts", mode: "100755", content: bytes("a") }]);
    const first = ok(input);
    const second = ok(input);
    expect(second).toEqual(first);
    expect(first.digest).toBe(digest(first.entries));
  });

  it("skills remap、workflow逆引き、package transformを既存distribution契約から合成する", () => {
    const template = bytes("workflow-template");
    const result = ok(
      fixture([
        { path: "docs/skills/example.md", mode: "100644", content: bytes("skill") },
        { path: ".github/workflows/harness-check.yml", mode: "100755", content: bytes("wrong") },
        {
          path: "docs/templates/github/common/pack-harness-check.yml",
          mode: "100644",
          content: template,
        },
      ]),
    );
    const skill = result.entries.find((entry) => entry.path === "skills/example.md");
    expect(skill).toBeDefined();
    expect([...(skill?.content ?? [])]).toEqual([...bytes("skill")]);
    const workflow = result.entries.find(
      (entry) => entry.path === ".github/workflows/harness-check.yml",
    );
    expect(workflow?.path).toBe(".github/workflows/harness-check.yml");
    expect(workflow?.mode).toBe("100644");
    expect([...(workflow?.content ?? [])]).toEqual([...template]);
    const pkg = result.entries.find((entry) => entry.path === "package.json");
    expect(Buffer.from(pkg?.content ?? []).toString()).toBe(
      transformCleanDistributionArtifact(
        "package.json",
        Buffer.from(
          fixture().find((entry) => entry.path === "package.json")?.content ?? [],
        ).toString(),
      ),
    );
  });

  it("destination path/mode/content/symlink targetの各byte差をdigestへ反映する", () => {
    const variants: ReleaseSourceEntry[][] = [
      fixture([{ path: "src/a.ts", mode: "100644", content: bytes("x") }]),
      fixture([{ path: "src/b.ts", mode: "100644", content: bytes("x") }]),
      fixture([{ path: "src/a.ts", mode: "100755", content: bytes("x") }]),
      fixture([{ path: "src/a.ts", mode: "100644", content: bytes("y") }]),
      fixture([{ path: "src/link", mode: "120000", content: bytes("a.ts") }]),
      fixture([{ path: "src/link", mode: "120000", content: bytes("b.ts") }]),
    ];
    expect(new Set(variants.map((entries) => ok(entries).digest)).size).toBe(variants.length);

    const regular = ok(fixture([{ path: "src/link", mode: "100644", content: bytes("a.ts") }]));
    const symlink = ok(fixture([{ path: "src/link", mode: "120000", content: bytes("a.ts") }]));
    expect(symlink.entries.find((entry) => entry.path === "src/link")?.mode).toBe("120000");
    expect(symlink.digest).not.toBe(regular.digest);
  });

  it("UTF-8 byte順とuint32be/uint64be framingをgolden digestで固定する", () => {
    const result = ok(
      fixture([
        { path: "src/é.ts", mode: "100644", content: bytes("é") },
        { path: "src/z.ts", mode: "100644", content: bytes("z") },
      ]),
    );
    expect(result.entries.map((entry) => entry.path).indexOf("src/z.ts")).toBeLessThan(
      result.entries.map((entry) => entry.path).indexOf("src/é.ts"),
    );
    expect(result.digest).toBe(digest(result.entries));
    const delimiterMutant = `sha256:${createHash("sha256")
      .update(
        result.entries
          .map((e) => `${e.path}|${e.mode}|${Buffer.from(e.content).toString("hex")}`)
          .join("|"),
      )
      .digest("hex")}`;
    expect(result.digest).not.toBe(delimiterMutant);
  });

  it("UTF-8 byte順とbig-endian framingをliteral golden digestで固定する", () => {
    const entries: ReleaseSourceEntry[] = [
      { path: "src/é.ts", mode: "100644", content: bytes("é") },
      { path: "src/z.ts", mode: "100644", content: bytes("z") },
    ];
    const base = buildCleanDistributionPlan({ paths: required });
    const result = materializeReleaseArtifacts(
      { materializerVersion: "1", entries },
      {
        buildPlan: () => ({
          ...base,
          artifactPaths: entries.map((entry) => entry.path),
          excludedPaths: [],
        }),
      },
    );

    expect(result.ok && result.entries.map((entry) => entry.path)).toEqual([
      "src/z.ts",
      "src/é.ts",
    ]);
    expect(result.ok && result.digest).toBe(
      "sha256:a38393406acf58f8f4b08e4d2dcf189d4688ada3539a552eb74f919752a336d6",
    );
  });

  it("dedupe前に異なるsourceから同じdestinationへの衝突を拒否する", () => {
    const entries = fixture([
      { path: "docs/skills/same.md", mode: "100644", content: bytes("legacy") },
      { path: "skills/same.md", mode: "100644", content: bytes("native") },
    ]);
    expect(materializeReleaseArtifacts({ materializerVersion: "1", entries })).toEqual({
      ok: false,
      error: "invalid_distribution_plan",
    });
  });

  it("invalid plan、missing source、0 artifactをtyped invalidへ倒す", () => {
    const invalidPlan = (paths: string[]) => ({
      ...buildCleanDistributionPlan({ paths }),
      ok: false,
    });
    expect(
      materializeReleaseArtifacts(
        { materializerVersion: "1", entries: fixture() },
        { buildPlan: invalidPlan },
      ),
    ).toEqual({ ok: false, error: "invalid_distribution_plan" });
    const missing = fixture().filter((entry) => entry.path !== "README.md");
    expect(
      materializeReleaseArtifacts(
        { materializerVersion: "1", entries: missing },
        {
          buildPlan: () => ({
            ...buildCleanDistributionPlan({ paths: required }),
            artifactPaths: ["README.md"],
          }),
        },
      ),
    ).toEqual({ ok: false, error: "invalid_distribution_plan" });
    expect(
      materializeReleaseArtifacts(
        { materializerVersion: "1", entries: fixture() },
        { buildPlan: (paths) => ({ ...buildCleanDistributionPlan({ paths }), artifactPaths: [] }) },
      ),
    ).toEqual({ ok: false, error: "invalid_distribution_plan" });
  });

  it.each([
    "",
    "/abs",
    "src/./a",
    "src/../a",
    "src\\a",
    "src/\0a",
    "src/\ud800.ts",
  ])("不正destination %jを正規化せず拒否する", (path) => {
    expect(
      materializeReleaseArtifacts(
        { materializerVersion: "1", entries: fixture() },
        {
          buildPlan: (paths) => ({
            ...buildCleanDistributionPlan({ paths }),
            artifactPaths: [path],
          }),
          sourcePath: () => "README.md",
        },
      ),
    ).toEqual({ ok: false, error: "invalid_artifact" });
  });

  it("unsupported modeとpackage UTF-8/JSON不正をtyped invalidへ倒す", () => {
    expect(
      materializeReleaseArtifacts({
        materializerVersion: "1",
        entries: fixture([{ path: "src/bad", mode: "100600" as "100644", content: bytes("x") }]),
      }),
    ).toEqual({ ok: false, error: "invalid_artifact" });
    for (const content of [new Uint8Array([0xff]), bytes("{")]) {
      const entries = fixture().map((entry) =>
        entry.path === "package.json" ? { ...entry, content } : entry,
      );
      expect(materializeReleaseArtifacts({ materializerVersion: "1", entries })).toEqual({
        ok: false,
        error: "invalid_artifact",
      });
    }
  });

  it.each([
    "/root",
    "C:/root",
    "C:relative",
    "//server/share",
    "../../outside",
    "a/../../../outside",
    "..\\..\\outside",
    "\\x",
    "bad\0target",
  ])("root外・absolute・NUL symlink %jを拒否する", (target) => {
    expect(
      materializeReleaseArtifacts({
        materializerVersion: "1",
        entries: fixture([{ path: "src/link", mode: "120000", content: bytes(target) }]),
      }),
    ).toEqual({ ok: false, error: "invalid_artifact" });
  });

  it.each([
    1,
    "v1",
    " 1",
    "2",
  ])("version token %jはfallbackせずunavailable", (materializerVersion) => {
    expect(materializeReleaseArtifacts({ materializerVersion, entries: fixture() })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("入力順に依存せず入力byteを変更せずcontrol manifestを明示除外する", () => {
    const control = {
      path: "release/manifest.yaml",
      mode: "100644" as const,
      content: bytes("one"),
    };
    const input = fixture([control]);
    const original = input.map((entry) => ({ ...entry, content: [...entry.content] }));
    const deps = {
      buildPlan: (paths: string[]) => ({
        ...buildCleanDistributionPlan({ paths }),
        artifactPaths: [
          ...buildCleanDistributionPlan({ paths }).artifactPaths,
          "release/manifest.yaml",
        ],
      }),
      artifactPath: cleanDistributionArtifactPath,
      sourcePath: cleanDistributionSourcePath,
    };
    const first = materializeReleaseArtifacts({ materializerVersion: "1", entries: input }, deps);
    const reversed = materializeReleaseArtifacts(
      { materializerVersion: "1", entries: [...input].reverse() },
      deps,
    );
    const changed = materializeReleaseArtifacts(
      { materializerVersion: "1", entries: fixture([{ ...control, content: bytes("two") }]) },
      deps,
    );
    expect(first).toEqual(reversed);
    expect(first).toEqual(changed);
    expect(first.ok && first.entries.some((entry) => entry.path === control.path)).toBe(false);
    expect(input.map((entry) => ({ ...entry, content: [...entry.content] }))).toEqual(original);
  });

  it("返却contentを書き換えてもimmutable snapshotとdigestは変わらない", () => {
    const result = ok(fixture([{ path: "src/a.ts", mode: "100644", content: bytes("abc") }]));
    const entry = result.entries.find((candidate) => candidate.path === "src/a.ts");
    if (!entry) throw new Error("missing materialized entry");
    const originalContent = [...entry.content];
    const originalDigest = result.digest;

    entry.content[0] = 0;

    expect([...entry.content]).toEqual(originalContent);
    expect(result.digest).toBe(originalDigest);
    expect(result.digest).toBe(digest(result.entries));
  });
});
