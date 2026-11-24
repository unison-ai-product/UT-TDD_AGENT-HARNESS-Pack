import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import { selectPackBuildInputs } from "../src/setup/pack-build-inputs.ts";
import {
  derivePackPublicationAssets,
  type SealedPublicationEntry,
} from "../src/setup/pack-publication-assets.ts";
import {
  auditPackPublication,
  buildPackPublicationStagingPlan,
  type PackPublicationCommitEntry,
} from "../src/setup/pack-publication-staging.ts";

// Red (issue #1882): U-PKBIN-001..017 のうち 012 (L12 受入、control が実機で実施) を除く。
// 契約は docs/design/harness/L6-function-design/pack-build-inputs.md、oracle は
// docs/test-design/harness/L7-pack-build-inputs-test-design.md。

const FIXED = [
  "docs/governance/node-toolchain-provenance.json",
  "docs/governance/vmodel-document-catalog.md",
  "tsconfig.node.json",
] as const;
const TPL_A = "docs/templates/vmodel/a-template.md";
const TPL_B = "docs/templates/vmodel/sub/b-template.md";

function fullTree(): string[] {
  return [
    ...FIXED,
    TPL_A,
    TPL_B,
    "docs/templates/vmodel/review-examples/example.md",
    "docs/templates/vmodel/notes.txt",
    "src/cli.ts",
    "README.md",
  ];
}

describe("U-PKBIN selectPackBuildInputs (pure)", () => {
  it("U-PKBIN-001: 揃った tree から固定 3 件と対象テンプレートだけを昇順で選ぶ", () => {
    const result = selectPackBuildInputs([...fullTree()].reverse());
    expect(result).toEqual({ ok: true, paths: [...FIXED, TPL_A, TPL_B].sort() });
  });

  it.each(
    FIXED,
  )("U-PKBIN-002: 固定 file %s だけが欠けると、その 1 件の missing だけを返す", (gone) => {
    const result = selectPackBuildInputs(fullTree().filter((path) => path !== gone));
    expect(result).toEqual({
      ok: false,
      reasons: [{ code: "pack_build_input_missing", path: gone }],
    });
  });

  it("U-PKBIN-003: テンプレートが 0 件なら template_set_empty だけを返す", () => {
    const tree = fullTree().filter((path) => !path.startsWith("docs/templates/vmodel/"));
    expect(selectPackBuildInputs(tree)).toEqual({
      ok: false,
      reasons: [{ code: "pack_build_input_template_set_empty" }],
    });
  });

  it("U-PKBIN-004: working tree にだけ在る固定 file は untracked、exists 無しなら missing", () => {
    const gone = "tsconfig.node.json";
    const tree = fullTree().filter((path) => path !== gone);
    expect(selectPackBuildInputs(tree, (path) => path === gone)).toEqual({
      ok: false,
      reasons: [{ code: "pack_build_input_untracked", path: gone }],
    });
    expect(selectPackBuildInputs(tree)).toEqual({
      ok: false,
      reasons: [{ code: "pack_build_input_missing", path: gone }],
    });
  });

  it("U-PKBIN-005: 複数の欠落を path の昇順で全て返す", () => {
    const tree = fullTree().filter(
      (path) =>
        path !== FIXED[0] && path !== FIXED[2] && !path.startsWith("docs/templates/vmodel/"),
    );
    expect(selectPackBuildInputs(tree)).toEqual({
      ok: false,
      reasons: [
        { code: "pack_build_input_missing", path: FIXED[0] },
        { code: "pack_build_input_missing", path: FIXED[2] },
        { code: "pack_build_input_template_set_empty" },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Publication audit expected set (013-017)
// ---------------------------------------------------------------------------

const sourceCommit = "a".repeat(40);
const artifactSetDigest = `sha256:${"b".repeat(64)}`;
const sha = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface ArtifactSpec {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly mode: "100644" | "100755";
  readonly content: Buffer;
}

function sealed(spec: ArtifactSpec): SealedPublicationEntry {
  return {
    sourcePath: spec.sourcePath,
    destinationPath: spec.destinationPath,
    mode: spec.mode,
    size: spec.content.length,
    contentDigest: sha(spec.content),
    content: spec.content,
  };
}

function publicationFixture(specs: readonly ArtifactSpec[]) {
  const payload = Buffer.concat([
    Buffer.from("v2", "ascii"),
    Buffer.from([0]),
    Buffer.from(sourceCommit, "ascii"),
    Buffer.from([0]),
    Buffer.from(artifactSetDigest.slice(7), "hex"),
  ]);
  const releaseId = `rel-sha256:${createHash("sha256").update(payload).digest("hex")}`;
  const entries = specs.map(sealed);
  const artifacts = entries.map(({ content: _content, ...artifact }) => artifact);
  const artifactInventoryDigest = deriveArtifactInventoryDigest(artifacts);
  const provisional = {
    releaseId,
    materializerVersion: "v2",
    artifactSourceCommit: sourceCommit,
    artifactSetDigest,
    artifactInventoryDigest,
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    releaseRecordDigest: `sha256:${"d".repeat(64)}`,
    artifacts,
  };
  const assets = derivePackPublicationAssets({ release: provisional, entries });
  if (!assets.ok) throw new Error(`fixture assets: ${assets.error}`);
  const releaseAssetInventoryDigest = assets.value.releaseAssetInventoryDigest;
  const releaseRecordDigest = deriveReleaseRecordDigest({
    materializerVersion: "v2",
    artifactSourceCommit: sourceCommit,
    artifactSetDigest,
    artifactInventoryDigest,
    releaseAssetInventoryDigest,
  });
  const manifestInput = {
    schema_version: "v2",
    releases: {
      [releaseId]: {
        materializerVersion: "v2",
        artifactSourceCommit: sourceCommit,
        artifactSetDigest,
        artifactInventoryDigest,
        releaseAssetInventoryDigest,
        releaseRecordDigest,
        artifacts,
      },
    },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
  return {
    manifestInput,
    releaseId,
    entries,
    controlManifestBytes: Buffer.from(stringify(manifestInput), "utf8"),
  };
}

interface BuildInput {
  readonly path: string;
  readonly bytes: Buffer;
}

const BIN: ArtifactSpec = {
  sourcePath: "src/cli.ts",
  destinationPath: "bin/ut-tdd.js",
  mode: "100755",
  content: Buffer.from("abc"),
};
const BUILD_INPUTS: readonly BuildInput[] = [
  { path: FIXED[0], bytes: Buffer.from('{"provenance":true}\n') },
  { path: FIXED[1], bytes: Buffer.from("# catalog\n") },
  { path: FIXED[2], bytes: Buffer.from('{"extends":"./tsconfig.json"}\n') },
  { path: TPL_A, bytes: Buffer.from("# template a\n") },
];

function stagingInput(
  specs: readonly ArtifactSpec[],
  buildInputs: readonly BuildInput[],
): Parameters<typeof buildPackPublicationStagingPlan>[0] {
  // `buildInputs` は契約 §5.1 の「呼び出し側が渡す { path, bytes } の列」。入力名は実装で変えてよいが意味は変えない。
  return { ...publicationFixture(specs), buildInputs } as Parameters<
    typeof buildPackPublicationStagingPlan
  >[0];
}

function observedEntry(
  path: string,
  mode: "100644" | "100755",
  kind: string,
  bytes: Buffer,
): PackPublicationCommitEntry {
  return {
    path,
    mode,
    size: bytes.length,
    contentDigest: sha(bytes),
    kind: kind as PackPublicationCommitEntry["kind"],
    bytes,
  };
}

function expectedC1(
  specs: readonly ArtifactSpec[],
  buildInputs: readonly BuildInput[],
  controlManifestBytes: Buffer,
): PackPublicationCommitEntry[] {
  // 期待集合を被検の実装に頼らず独立に組む: artifact + 重ならない build-input + control manifest。
  const artifactPaths = new Set(specs.map((spec) => spec.destinationPath));
  const entries = [
    ...specs.map((spec) =>
      observedEntry(spec.destinationPath, spec.mode, "artifact", spec.content),
    ),
    ...buildInputs
      .filter((input) => !artifactPaths.has(input.path))
      .map((input) => observedEntry(input.path, "100644", "build-input", input.bytes)),
    observedEntry("release/manifest.yaml", "100644", "control-manifest", controlManifestBytes),
  ];
  return entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
}

async function auditWith(
  plan: Extract<ReturnType<typeof buildPackPublicationStagingPlan>, { ok: true }>["plan"],
  commitEntries: readonly PackPublicationCommitEntry[],
) {
  return auditPackPublication(plan, {
    observe: () => ({
      commitEntries,
      releaseAssets: plan.releaseAssets,
      controlManifestSnapshotDigest: plan.controlManifestSnapshotDigest,
    }),
  });
}

function planOf(input: Parameters<typeof buildPackPublicationStagingPlan>[0]) {
  const result = buildPackPublicationStagingPlan(input);
  if (!result.ok) throw new Error(`staging plan failed: ${result.error}`);
  return result.plan;
}

describe("U-PKBIN publication expected set (§5.1)", () => {
  it("U-PKBIN-013: 期待集合にビルド入力を足し、正しい C1 を attested にする", async () => {
    const input = stagingInput([BIN], BUILD_INPUTS);
    const plan = planOf(input);
    const buildEntries = plan.commitEntries.filter(
      (entry) => (entry.kind as string) === "build-input",
    );
    expect(buildEntries.map((entry) => entry.path)).toEqual(
      [...BUILD_INPUTS.map((i) => i.path)].sort(),
    );
    for (const entry of buildEntries) {
      const source = BUILD_INPUTS.find((i) => i.path === entry.path);
      expect(entry.mode).toBe("100644");
      expect(Buffer.from(entry.bytes).equals(source?.bytes ?? Buffer.alloc(0))).toBe(true);
    }
    const observed = expectedC1([BIN], BUILD_INPUTS, Buffer.from(input.controlManifestBytes));
    expect((await auditWith(plan, observed)).status).toBe("attested");
    // 公開物は変わらない: tar / manifest の artifacts[] にビルド入力は入らない。
    const baseline = planOf(stagingInput([BIN], []));
    expect(plan.releaseAssets.map((asset) => asset.contentDigest)).toEqual(
      baseline.releaseAssets.map((asset) => asset.contentDigest),
    );
    expect(Object.keys(plan.manifest.releases).length).toBe(1);
    const release = Object.values(plan.manifest.releases)[0];
    expect(release.artifacts.map((artifact) => artifact.destinationPath)).toEqual([
      BIN.destinationPath,
    ]);
  });

  it("U-PKBIN-014: 期待集合に無い 100644 file が 1 件増えると commit_entries_mismatch", async () => {
    const input = stagingInput([BIN], BUILD_INPUTS);
    const plan = planOf(input);
    const control = Buffer.from(input.controlManifestBytes);
    const correct = expectedC1([BIN], BUILD_INPUTS, control);
    expect((await auditWith(plan, correct)).status).toBe("attested");
    const withExtra = [
      ...correct,
      observedEntry("zz-extra.txt", "100644", "build-input", Buffer.from("x")),
    ];
    expect(await auditWith(plan, withExtra)).toEqual({
      status: "partial_publication",
      reason: "commit_entries_mismatch",
    });
  });

  it("U-PKBIN-015: ビルド入力が 1 件欠けた C1 は commit_entries_mismatch", async () => {
    const input = stagingInput([BIN], BUILD_INPUTS);
    const plan = planOf(input);
    const control = Buffer.from(input.controlManifestBytes);
    const correct = expectedC1([BIN], BUILD_INPUTS, control);
    expect((await auditWith(plan, correct)).status).toBe("attested");
    const missing = correct.filter((entry) => entry.path !== TPL_A);
    expect(missing.length).toBe(correct.length - 1);
    expect(await auditWith(plan, missing)).toEqual({
      status: "partial_publication",
      reason: "commit_entries_mismatch",
    });
  });

  it("U-PKBIN-016: ビルド入力 1 件の bytes だけが 1 byte 違う C1 は commit_entries_mismatch", async () => {
    const input = stagingInput([BIN], BUILD_INPUTS);
    const plan = planOf(input);
    const control = Buffer.from(input.controlManifestBytes);
    const correct = expectedC1([BIN], BUILD_INPUTS, control);
    expect((await auditWith(plan, correct)).status).toBe("attested");
    const tampered = correct.map((entry) => {
      if (entry.path !== TPL_A) return entry;
      const bytes = Buffer.from(entry.bytes);
      bytes[0] = bytes[0] ^ 0x01; // path / mode / size は同じ
      return { ...entry, bytes, contentDigest: sha(bytes) };
    });
    expect(await auditWith(plan, tampered)).toEqual({
      status: "partial_publication",
      reason: "commit_entries_mismatch",
    });
  });

  it("U-PKBIN-017: artifact と重なる path は artifact の変換後 bytes を 1 件だけ期待する", async () => {
    const overlap: ArtifactSpec = {
      sourcePath: "tsconfig.pack.json",
      destinationPath: FIXED[2],
      mode: "100644",
      content: Buffer.from("TRANSFORMED artifact bytes\n"),
    };
    const specs = [BIN, overlap];
    const input = stagingInput(specs, BUILD_INPUTS); // BUILD_INPUTS は FIXED[2] を source の bytes で含む
    const plan = planOf(input);
    const atOverlap = plan.commitEntries.filter((entry) => entry.path === FIXED[2]);
    expect(atOverlap).toHaveLength(1);
    expect(atOverlap[0].kind).toBe("artifact");
    expect(Buffer.from(atOverlap[0].bytes).equals(overlap.content)).toBe(true);
    // 重ならないビルド入力は従来どおり build-input として期待される。
    expect(
      plan.commitEntries
        .filter((entry) => (entry.kind as string) === "build-input")
        .map((e) => e.path),
    ).toEqual(
      BUILD_INPUTS.filter((i) => i.path !== FIXED[2])
        .map((i) => i.path)
        .sort(),
    );
    const observed = expectedC1(specs, BUILD_INPUTS, Buffer.from(input.controlManifestBytes));
    expect((await auditWith(plan, observed)).status).toBe("attested");
  });
});
