import { describe, expect, it, vi } from "vitest";
import { captureRepositoryDocsSnapshot } from "../../src/document-disposition/application/capture-repository-docs-snapshot.ts";
import type {
  GitObjectSnapshotPort,
  GitObjectTreeSnapshot,
} from "../../src/document-disposition/ports/git-object-snapshot.ts";

const FULL_COMMIT = "1".repeat(40);
const ROOT_TREE = "2".repeat(40);
const SELECTION_DIGEST = "a".repeat(64);
const RAW_PATH_STREAM = Uint8Array.from(
  Buffer.from(
    "2e75742d7464642f6d656d6f72792f706f6c6963792e6d64004147454e54532e6d6400646f63732f612e6d6400",
    "hex",
  ),
);

const TREE_SNAPSHOT: GitObjectTreeSnapshot = {
  commitOid: FULL_COMMIT,
  repositoryTreeOid: ROOT_TREE,
  rawPathStream: RAW_PATH_STREAM,
  unclassifiedPathStream: new Uint8Array(),
  members: [
    {
      pathBytes: Uint8Array.from(Buffer.from(".ut-tdd/memory/policy.md", "utf8")),
      blobOid: "3".repeat(40),
      contentSha256: "b".repeat(64),
      fileMode: "100644",
      zone: "runtime_policy",
    },
    {
      pathBytes: Uint8Array.from(Buffer.from("AGENTS.md", "utf8")),
      blobOid: "4".repeat(40),
      contentSha256: "c".repeat(64),
      fileMode: "100644",
      zone: "root_policy",
    },
    {
      pathBytes: Uint8Array.from(Buffer.from("docs/a.md", "utf8")),
      blobOid: "5".repeat(40),
      contentSha256: "d".repeat(64),
      fileMode: "100644",
      zone: "docs_tree",
    },
  ],
  zones: [
    {
      zone: "docs_tree",
      selectorDigest: "7".repeat(64),
      memberCount: 1,
      treeOid: "6".repeat(40),
    },
    { zone: "root_policy", selectorDigest: "8".repeat(64), memberCount: 1 },
    { zone: "runtime_policy", selectorDigest: "9".repeat(64), memberCount: 1 },
    { zone: "skills", selectorDigest: "e".repeat(64), memberCount: 0 },
    { zone: "github_policy", selectorDigest: "f".repeat(64), memberCount: 0 },
  ],
};

function port(snapshot: GitObjectTreeSnapshot = TREE_SNAPSHOT): GitObjectSnapshotPort {
  return { readTree: vi.fn().mockResolvedValue(snapshot) };
}

const INPUT = {
  repositoryIdentity: "repo:example/harness",
  commitOid: FULL_COMMIT,
  repositoryTreeOid: ROOT_TREE,
  selectionRevision: "repository-documents-v1",
  selectionDigest: SELECTION_DIGEST,
} as const;

describe("captureRepositoryDocsSnapshot", () => {
  it("U-DOCLEDGER-001: Git objectの全zoneをcanonical snapshot identityへ固定する", async () => {
    const git = port();

    const result = await captureRepositoryDocsSnapshot(INPUT, git);

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        snapshotId:
          "document-snapshot:sha256:9c3165a95c7768e86e04fb370692f3ad0f9a86bf00cd4ee5422ca40a321fb07d",
        snapshotDigest: "9c3165a95c7768e86e04fb370692f3ad0f9a86bf00cd4ee5422ca40a321fb07d",
        pathStreamSha256: "cbbb3a2a0a6248e0697e6a12b8b1d293d482d0c6d7ddf902c2a9fbbf1e77d579",
        zoneSetDigest: "509734b259de58626cfad5fd640cacb6edc79bc6918de74e2ba40427f60bf807",
        memberSetDigest: "6f75de8715fcf9334ba259daadfff55b5bb5e32f172132a4a8da2e0610912ddf",
        trackedCount: 3,
        zones: expect.arrayContaining([
          expect.objectContaining({
            zone: "docs_tree",
            treeOid: "6".repeat(40),
            memberCount: 1,
            memberSetDigest: "046c3e32e9a8ac3de0e54a8f9973f769a0999d5bfb47c2a2a58f1b5503cc5f9f",
          }),
        ]),
        members: [
          expect.objectContaining({ path: ".ut-tdd/memory/policy.md", zone: "runtime_policy" }),
          expect.objectContaining({ path: "AGENTS.md", zone: "root_policy" }),
          expect.objectContaining({ path: "docs/a.md", zone: "docs_tree" }),
        ],
      }),
    });
    expect(git.readTree).toHaveBeenCalledWith(INPUT);
  });

  it("U-DOCLEDGER-001: validなzone tree差替えはsnapshot identityを変更する", async () => {
    const changed = {
      ...TREE_SNAPSHOT,
      zones: TREE_SNAPSHOT.zones.map((zone) =>
        zone.zone === "docs_tree" ? { ...zone, treeOid: "0".repeat(40) } : zone,
      ),
    };

    const result = await captureRepositoryDocsSnapshot(INPUT, port(changed));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.zoneSetDigest).not.toBe(
      "509734b259de58626cfad5fd640cacb6edc79bc6918de74e2ba40427f60bf807",
    );
    expect(result.value.snapshotDigest).not.toBe(
      "9c3165a95c7768e86e04fb370692f3ad0f9a86bf00cd4ee5422ca40a321fb07d",
    );
  });

  it.each([
    ["short commit", { ...INPUT, commitOid: "1234567" }],
    ["symbolic commit", { ...INPUT, commitOid: "HEAD" }],
  ])("U-DOCLEDGER-002: %sはport呼出し前にrevision missingで拒否する", async (_label, input) => {
    const git = port();

    const result = await captureRepositoryDocsSnapshot(input, git);

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          ruleId: "docs-snapshot-revision-missing",
          exitCode: 1,
        }),
      ],
    });
    expect(git.readTree).not.toHaveBeenCalled();
  });

  it.each([
    [
      "tree mismatch",
      { ...TREE_SNAPSHOT, repositoryTreeOid: "f".repeat(40) },
      "docs-snapshot-stream-malformed",
    ],
    [
      "NUL terminator missing",
      { ...TREE_SNAPSHOT, rawPathStream: RAW_PATH_STREAM.slice(0, -1) },
      "docs-snapshot-stream-malformed",
    ],
    [
      "required zone missing",
      {
        ...TREE_SNAPSHOT,
        zones: TREE_SNAPSHOT.zones.filter(({ zone }) => zone !== "github_policy"),
      },
      "doc-selection-unclassified",
    ],
    [
      "unclassified tracked document",
      {
        ...TREE_SNAPSHOT,
        unclassifiedPathStream: Uint8Array.from(Buffer.from("notes/decision.md\0", "utf8")),
      },
      "doc-selection-unclassified",
    ],
    [
      "zone count mismatch",
      {
        ...TREE_SNAPSHOT,
        zones: TREE_SNAPSHOT.zones.map((zone) =>
          zone.zone === "docs_tree" ? { ...zone, memberCount: 2 } : zone,
        ),
      },
      "doc-selection-unclassified",
    ],
    [
      "malformed docs tree OID",
      {
        ...TREE_SNAPSHOT,
        zones: TREE_SNAPSHOT.zones.map((zone) =>
          zone.zone === "docs_tree" ? { ...zone, treeOid: "not-an-oid" } : zone,
        ),
      },
      "doc-selection-unclassified",
    ],
    [
      "malformed blob OID",
      {
        ...TREE_SNAPSHOT,
        members: TREE_SNAPSHOT.members.map((member, index) =>
          index === 0 ? { ...member, blobOid: "not-an-oid" } : member,
        ),
      },
      "docs-snapshot-stream-malformed",
    ],
    [
      "path assigned to wrong zone",
      {
        ...TREE_SNAPSHOT,
        members: TREE_SNAPSHOT.members.map((member, index) =>
          index === 0 ? { ...member, zone: "docs_tree" as const } : member,
        ),
        zones: TREE_SNAPSHOT.zones.map((zone) =>
          zone.zone === "docs_tree"
            ? { ...zone, memberCount: 2 }
            : zone.zone === "runtime_policy"
              ? { ...zone, memberCount: 0 }
              : zone,
        ),
      },
      "doc-selection-unclassified",
    ],
    [
      "invalid UTF-8 path",
      {
        ...TREE_SNAPSHOT,
        rawPathStream: Uint8Array.from([0xff, 0, ...Buffer.from("AGENTS.md\0docs/a.md\0", "utf8")]),
        members: TREE_SNAPSHOT.members.map((member, index) =>
          index === 0 ? { ...member, pathBytes: Uint8Array.from([0xff]) } : member,
        ),
      },
      "docs-snapshot-stream-malformed",
    ],
    [
      "non-NFC path",
      {
        ...TREE_SNAPSHOT,
        rawPathStream: Uint8Array.from(
          Buffer.from(".ut-tdd/memory/policy.md\0AGENTS.md\0docs/e\u0301.md\0", "utf8"),
        ),
        members: TREE_SNAPSHOT.members.map((member, index) =>
          index === 2
            ? { ...member, pathBytes: Uint8Array.from(Buffer.from("docs/e\u0301.md", "utf8")) }
            : member,
        ),
      },
      "docs-snapshot-stream-malformed",
    ],
  ])("U-DOCLEDGER-002: %sをfail-closeする", async (_label, snapshot, ruleId) => {
    const result = await captureRepositoryDocsSnapshot(INPUT, port(snapshot));

    expect(result).toEqual({
      ok: false,
      errors: [expect.objectContaining({ ruleId, exitCode: 1 })],
    });
  });
});
