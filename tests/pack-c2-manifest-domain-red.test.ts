import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  deriveReleaseId,
  deriveReleaseRecordDigest,
  parsePublicationManifest,
} from "../src/schema/release-manifest.ts";
import { C2_GOLDEN } from "./fixtures/pack-c2-manifest-golden.ts";
import { C1, CONTENT, createDomainFixture } from "./support/pack-c2-manifest-domain-fixture.ts";
import {
  CONCURRENT_PATH,
  createWriteFaultPorts,
  KEEP_PATH,
  MANIFEST_PATH,
  PACK_ROOT,
  RELEASE_DIR,
  type WriteFault,
} from "./support/pack-c2-manifest-write-faults.ts";

type Builder = (input: unknown, deps: unknown) => Promise<unknown> | unknown;
type Writer = (root: string, bytes: Uint8Array, fs: unknown) => Promise<unknown> | unknown;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Expected a Pack C2 object");
  return value as Record<string, unknown>;
}

function manifestBytes(result: unknown): Buffer {
  expect(result).toMatchObject({ ok: true });
  const { bytes } = record(record(result).value);
  if (!(bytes instanceof Uint8Array)) throw Error("Expected UTF-8 manifest bytes");
  return Buffer.from(bytes);
}

function publication(text: string) {
  const raw = parse(text);
  const parsed = parsePublicationManifest(raw);
  if (!parsed.ok) throw Error(`Invalid fixture publication manifest: ${parsed.error}`);
  return { raw: record(raw), parsed: parsed.value };
}

const fixture = createDomainFixture();
const previousText = Buffer.from(fixture.input.previousBytes).toString("utf8");
const loggedAssets = () => ({
  ok: true,
  value: { releaseAssetInventoryDigest: fixture.assetDigest },
});
const deps = {
  trackedEntries: fixture.trackedEntries,
  resolveArtifacts: () => fixture.resolution,
  deriveAssets: loggedAssets,
};

let builder: Builder | undefined;
let writer: Writer | undefined;
beforeAll(async () => {
  publication(previousText);
  publication(C2_GOLDEN);
  const executionRoot = process.env.UT_TDD_TEST_EXECUTION_ROOT;
  if (!executionRoot) throw Error("The test execution snapshot is required");
  const modulePath = join(executionRoot, "src", "setup", "pack-c2-manifest.ts");
  // During Red, the planned module is absent. Errors in a present module still fail setup.
  if (!existsSync(modulePath)) return;
  const module = await import(pathToFileURL(modulePath).href);
  builder = module.buildC2ReleaseManifest;
  writer = module.writeC2Manifest;
});

async function build(
  overrides: Partial<Record<keyof typeof deps, unknown>> = {},
  input = fixture.input,
) {
  expect(typeof builder).toBe("function");
  return builder?.(input, { ...deps, ...overrides });
}

function expectRejected(result: unknown, reason: string, detail?: string) {
  expect(result).toMatchObject({ ok: false });
  const failure = record(result);
  const [code, ...details] = String(failure.reason).split(":");
  expect(code).toBe(reason);
  if (detail) expect(details.join(":")).toContain(detail);
  expect(failure.value).toBeUndefined();
}

describe("Pack C2 manifest domain candidate oracles", () => {
  it("U-C2MAN-001: fixed input yields pinned golden manifest bytes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      vi.stubEnv("TZ", "UTC");
      const first = manifestBytes(await build());
      vi.setSystemTime(new Date("2040-06-30T12:34:56Z"));
      vi.stubEnv("TZ", "Pacific/Kiritimati");
      const second = manifestBytes(
        await build(
          {},
          {
            ...fixture.input,
            repository: `${fixture.input.repository}-other-checkout`,
          },
        ),
      );
      expect(first).toEqual(Buffer.from(C2_GOLDEN, "utf8"));
      expect(second).toEqual(first);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("U-C2MAN-003: preserves stable, release order and previous records", async () => {
    const after = publication(manifestBytes(await build()).toString("utf8"));
    const before = publication(previousText);
    expect(after.parsed.channels.stable).toBe(before.parsed.channels.stable);
    expect(after.parsed.channelOrder).toEqual(before.parsed.channelOrder);
    const oldRecords = Object.entries(record(before.raw.releases));
    const newRecords = record(after.raw.releases);
    expect(Object.keys(newRecords).slice(0, oldRecords.length)).toEqual(
      oldRecords.map(([id]) => id),
    );
    for (const [id, oldRecord] of oldRecords) {
      expect(newRecords[id]).toEqual(oldRecord);
      expect(Object.keys(record(newRecords[id]))).toEqual(Object.keys(record(oldRecord)));
    }
  });

  it("U-C2MAN-004: appends one release and moves only canary", async () => {
    const idsBefore = Object.keys(publication(previousText).parsed.releases);
    const { releases, channels } = publication(
      manifestBytes(await build()).toString("utf8"),
    ).parsed;
    expect(Object.keys(releases)).toEqual([...idsBefore, channels.canary]);
    expect(idsBefore).not.toContain(channels.canary);
  });

  it("U-C2MAN-005: uses derived asset digest and recomputes record digest", async () => {
    const deriveAssets = vi.fn(loggedAssets);
    const { releases, channels } = publication(
      manifestBytes(await build({ deriveAssets })).toString("utf8"),
    ).parsed;
    const release = releases[channels.canary];
    expect(deriveAssets).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        release: expect.objectContaining({
          releaseId: channels.canary,
          artifacts: release.artifacts,
        }),
        entries: release.artifacts.map((artifact) => ({ ...artifact, content: CONTENT })),
      }),
    );
    expect(release.releaseAssetInventoryDigest).toBe(fixture.assetDigest);
    expect(release.releaseRecordDigest).toBe(deriveReleaseRecordDigest(release));
  });

  it("U-C2MAN-006: derives artifact set and release ID from resolved digest", async () => {
    const { releases, channels } = publication(
      manifestBytes(await build()).toString("utf8"),
    ).parsed;
    expect(releases[channels.canary].artifactSetDigest).toBe(fixture.resolution.digest);
    expect(channels.canary).toBe(deriveReleaseId("1", C1, fixture.resolution.digest));
  });

  it.each([
    ["symlink mode", "120000", "README.md"],
    ["untracked path", "100644", "not-in-c1.txt"],
  ])("U-C2MAN-014: rejects %s", async (_label, mode, path) => {
    const resolveArtifacts = () => ({
      ...fixture.resolution,
      entries: [{ path, mode, content: CONTENT }],
    });
    expectRejected(await build({ resolveArtifacts }), "c2_inventory_invalid");
  });

  it.each([
    "invalid_distribution_plan",
    "unavailable",
    "invalid_artifact",
  ])("U-C2MAN-015: surfaces resolver failure %s", async (error) => {
    const resolveArtifacts = () => ({ ok: false, error });
    expectRejected(await build({ resolveArtifacts }), "c2_artifact_resolution_failed", error);
  });

  it.each([
    "invalid_release",
    "artifact_mismatch",
    "unsupported_path",
    "unsupported_entry",
    "asset_inventory_mismatch",
  ])("U-C2MAN-016: surfaces asset derivation failure %s", async (error) => {
    const deriveAssets = () => ({ ok: false, error });
    expectRejected(await build({ deriveAssets }), "c2_assets_failed", error);
  });

  it("U-C2MAN-017: rejects an invalid assembled manifest before returning bytes", async () => {
    const deriveAssets = () => ({
      ok: true,
      value: { releaseAssetInventoryDigest: "sha256:invalid" },
    });
    expectRejected(await build({ deriveAssets }), "c2_manifest_invalid");
  });

  it("U-C2MAN-018: rejects a release ID already registered in previous", async () => {
    const input = { ...fixture.input, previousBytes: Buffer.from(C2_GOLDEN, "utf8") };
    expectRejected(await build({}, input), "c2_release_already_registered");
  });

  const writeCases: [WriteFault, boolean][] = [
    ["open", false],
    ["open", true],
    ["write", false],
    ["write", true],
    ["close", false],
    ["close", true],
    ["unlink", false],
  ];
  it.each(
    writeCases,
  )("U-C2MAN-019: write fault %s with preexisting release directory %s", async (fault, preexistingRelease) => {
    const { fs, files, dirs, operations } = createWriteFaultPorts(fault, preexistingRelease);
    expect(typeof writer).toBe("function");
    const result = await writer?.(PACK_ROOT, Buffer.from(C2_GOLDEN, "utf8"), fs);
    expectRejected(result, "c2_write_failed", fault === "unlink" ? MANIFEST_PATH : undefined);
    expect(operations).toContain("open:wx");
    expect(operations.includes("unlink")).toBe(fault !== "open");
    expect(dirs.has(RELEASE_DIR)).toBe(preexistingRelease || fault === "unlink");
    const expectedFiles = new Map();
    if (preexistingRelease) expectedFiles.set(KEEP_PATH, Buffer.from("keep\n"));
    if (fault === "open" && preexistingRelease)
      expectedFiles.set(MANIFEST_PATH, Buffer.from("other manifest\n"));
    if (fault === "write" && preexistingRelease)
      expectedFiles.set(CONCURRENT_PATH, Buffer.from("other\n"));
    if (fault === "unlink") expectedFiles.set(MANIFEST_PATH, Buffer.from("partial"));
    expect(files).toEqual(expectedFiles);
  });
});
