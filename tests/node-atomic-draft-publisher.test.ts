import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DraftPublisherFaultPoint,
  NODE_PATH_MUTATION_SAFETY,
  NodeAtomicDraftPublisher,
} from "../src/plan-admission/node-atomic-draft-publisher.ts";

const roots: string[] = [];

function fixture(fault?: (point: DraftPublisherFaultPoint, path: string) => void) {
  const root = join(tmpdir(), `ut-tdd-atomic-draft-${process.pid}-${roots.length}`);
  roots.push(root);
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "governance"), { recursive: true });
  const source = "docs/plans/PLAN-L7-999.md";
  const projection = "docs/governance/plan-admission-receipts.json";
  writeFileSync(join(root, source), "old-source", "utf8");
  writeFileSync(join(root, projection), "old-projection", "utf8");
  const publisher = new NodeAtomicDraftPublisher({
    rootDir: root,
    injectFault: fault,
    createId: () => "fixture",
  });
  const artifacts = [
    { path: source, content: "new-source" },
    { path: projection, content: "new-projection" },
  ] as const;
  return { root, source, projection, publisher, artifacts };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NodeAtomicDraftPublisher", () => {
  it("U-PADM-032: stages and publishes source/projection through durable rename", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    f.publisher.publish(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("new-projection");
    expect(
      readdirSync(join(f.root, "docs", "plans")).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
    expect(() => f.publisher.publish(token)).not.toThrow();
  });

  it("U-PADM-033: restores both old files after a partial publish and is idempotent", () => {
    let targetRenames = 0;
    const f = fixture((point) => {
      if (point === "publish:after-target-rename" && ++targetRenames === 1)
        throw new Error("fault");
    });
    const token = f.publisher.stage(f.artifacts);
    expect(() => f.publisher.publish(token)).toThrow("fault");
    f.publisher.restore(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("old-projection");
    expect(() => f.publisher.restore(token)).not.toThrow();
  });

  it("U-PADM-034: restore can be retried after an injected restore failure", () => {
    let fail = true;
    const f = fixture((point) => {
      if (point === "restore:before-artifact" && fail) {
        fail = false;
        throw new Error("restore fault");
      }
    });
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    expect(() => f.publisher.restore(token)).toThrow("restore fault");
    f.publisher.restore(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("old-projection");
  });

  it("U-PADM-035: rejects lexical and symlink root escape", () => {
    const f = fixture();
    expect(() =>
      f.publisher.stage([{ path: "../escape.md", content: "x" }, f.artifacts[1]]),
    ).toThrow(/root外/);

    const outside = join(tmpdir(), `ut-tdd-atomic-outside-${process.pid}`);
    roots.push(outside);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() =>
      f.publisher.stage([{ path: "linked/escape.md", content: "x" }, f.artifacts[1]]),
    ).toThrow(/root外/);
  });

  it("U-PADM-036: stage fault cleans temporary and rollback files", () => {
    const f = fixture((point, path) => {
      if (point === "stage:after-write" && path === f.source) throw new Error("stage fault");
    });
    expect(() => f.publisher.stage(f.artifacts)).toThrow("stage fault");
    expect(readdirSync(join(f.root, "docs", "plans"))).toEqual(["PLAN-L7-999.md"]);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
  });

  it("U-PADM-037: new targets are removed by restore", () => {
    const f = fixture();
    rmSync(join(f.root, f.source));
    rmSync(join(f.root, f.projection));
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    f.publisher.restore(token);
    expect(() => readFileSync(join(f.root, f.source), "utf8")).toThrow();
    expect(() => readFileSync(join(f.root, f.projection), "utf8")).toThrow();
  });

  it("U-PADM-044: finalize preserves published content and idempotently removes recovery files", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    f.publisher.finalize(token);

    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("new-projection");
    expect(readdirSync(join(f.root, "docs", "plans"))).toEqual(["PLAN-L7-999.md"]);
    expect(readdirSync(join(f.root, "docs", "governance"))).toEqual([
      "plan-admission-receipts.json",
    ]);
    expect(() => f.publisher.finalize(token)).not.toThrow();
  });

  it("U-PADM-045: finalize rejects an unknown token even when its id matches", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    expect(() => f.publisher.finalize({ id: token.id })).toThrow(/未知または別publisher/);
  });

  it("U-PADM-046: finalize can resume cleanup after a fault without reverting published content", () => {
    let finalizedArtifacts = 0;
    const f = fixture((point) => {
      if (point === "finalize:after-artifact" && ++finalizedArtifacts === 1) {
        throw new Error("finalize fault");
      }
    });
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);

    expect(() => f.publisher.finalize(token)).toThrow("finalize fault");
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("new-projection");
    expect(() => f.publisher.finalize(token)).not.toThrow();
    expect(readdirSync(join(f.root, "docs", "plans"))).toEqual(["PLAN-L7-999.md"]);
    expect(readdirSync(join(f.root, "docs", "governance"))).toEqual([
      "plan-admission-receipts.json",
    ]);
  });

  it("U-PADM-047: publish直前のsource preimage driftを外部内容を保持して拒否する", () => {
    const f = fixture();
    const artifacts = [
      { ...f.artifacts[0], expectedPreimage: preimage("old-source") },
      { ...f.artifacts[1], expectedPreimage: preimage("old-projection") },
    ] as const;
    const token = f.publisher.stage(artifacts);
    writeFileSync(join(f.root, f.source), "concurrent-source", "utf8");

    expect(() => f.publisher.publish(token)).toThrow(/preimage/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("concurrent-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("old-projection");
  });

  it("U-PADM-048: source公開後のprojection driftを検出しreverse restoreできる", () => {
    const f = fixture((point, path) => {
      if (point === "publish:after-target-rename" && path === f.source) {
        writeFileSync(join(f.root, f.projection), "concurrent-projection", "utf8");
      }
    });
    const token = f.publisher.stage([
      { ...f.artifacts[0], expectedPreimage: preimage("old-source") },
      { ...f.artifacts[1], expectedPreimage: preimage("old-projection") },
    ]);

    expect(() => f.publisher.publish(token)).toThrow(/preimage/);
    f.publisher.restore(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("concurrent-projection");
  });

  it("U-PADM-049: absent対象のpublish前作成を上書きしない", () => {
    const f = fixture();
    rmSync(join(f.root, f.source));
    const token = f.publisher.stage([
      { ...f.artifacts[0], expectedPreimage: { kind: "absent" } },
      { ...f.artifacts[1], expectedPreimage: preimage("old-projection") },
    ]);
    writeFileSync(join(f.root, f.source), "concurrent-create", "utf8");

    expect(() => f.publisher.publish(token)).toThrow(/preimage/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("concurrent-create");
  });

  it("U-PADM-050: restore中のpostimage driftを削除せずrecoveryへ送る", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    writeFileSync(join(f.root, f.source), "concurrent-after-publish", "utf8");

    expect(() => f.publisher.restore(token)).toThrow(/published target CAS|postimage/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("concurrent-after-publish");
  });

  it("U-PADM-051: target link後のtemp cleanup faultから旧版へrestoreできる", () => {
    let failed = false;
    const f = fixture((point, path) => {
      if (point === "publish:after-target-link" && path === f.source && !failed) {
        failed = true;
        throw new Error("temp-cleanup-fault");
      }
    });
    const token = f.publisher.stage(f.artifacts);

    expect(() => f.publisher.publish(token)).toThrow("temp-cleanup-fault");
    f.publisher.restore(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("old-projection");
  });

  it("U-PADM-052: postimage削除後のfaultからrestoreを再開できる", () => {
    let failed = false;
    const f = fixture((point, path) => {
      if (point === "restore:after-target-remove" && path === f.projection && !failed) {
        failed = true;
        throw new Error("restore-window-fault");
      }
    });
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);

    expect(() => f.publisher.restore(token)).toThrow("restore-window-fault");
    f.publisher.restore(token);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("old-projection");
  });

  it("U-PADM-053: preimage mismatch復元窓の外部作成を上書きしない", () => {
    const f = fixture((point, path) => {
      if (point === "publish:before-preimage-restore" && path === f.source) {
        writeFileSync(join(f.root, f.source), "concurrent-restore-window", "utf8");
      }
    });
    const token = f.publisher.stage([
      { ...f.artifacts[0], expectedPreimage: preimage("expected-other-source") },
      { ...f.artifacts[1], expectedPreimage: preimage("old-projection") },
    ]);

    expect(() => f.publisher.publish(token)).toThrow(/preimage/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
  });

  it("U-PADM-054: restore窓の外部作成をrollback renameで上書きしない", () => {
    const f = fixture((point, path) => {
      if (point === "restore:after-target-remove" && path === f.projection) {
        writeFileSync(join(f.root, f.projection), "concurrent-restore", "utf8");
      }
    });
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);

    expect(() => f.publisher.restore(token)).toThrow(/postimage/);
    expect(readFileSync(join(f.root, f.projection), "utf8")).toBe("concurrent-restore");
  });

  it("U-PADM-055: stage後に同じpathへ差し替えられたparent directoryを拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    const parent = join(f.root, "docs", "plans");
    renameSync(parent, `${parent}-original`);
    mkdirSync(parent);

    expect(() => f.publisher.publish(token)).toThrow(/parent drift/);
    expect(readdirSync(parent)).toEqual([]);
    expect(readFileSync(join(`${parent}-original`, "PLAN-L7-999.md"), "utf8")).toBe("old-source");
  });

  it("U-PADM-056: publish途中のjunction/symlink parent差し替えをfail-closeする", () => {
    let substituted = false;
    const f = fixture((point, path) => {
      if (point !== "publish:after-backup-rename" || path !== f.source || substituted) return;
      substituted = true;
      const parent = join(f.root, "docs", "plans");
      const original = `${parent}-original`;
      renameSync(parent, original);
      symlinkSync(original, parent, process.platform === "win32" ? "junction" : "dir");
    });
    const token = f.publisher.stage(f.artifacts);

    expect(() => f.publisher.publish(token)).toThrow(/parent drift/);
    expect(() => readFileSync(join(f.root, f.source), "utf8")).toThrow();
    expect(readdirSync(join(f.root, "docs", "plans-original"))).not.toContain("PLAN-L7-999.md");
  });

  it("U-PADM-057: restore前のparent rename差し替えを外部directoryへ触れず拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    const parent = join(f.root, "docs", "plans");
    renameSync(parent, `${parent}-published`);
    mkdirSync(parent);
    writeFileSync(join(parent, "external.md"), "external", "utf8");

    expect(() => f.publisher.restore(token)).toThrow(/parent drift/);
    expect(readFileSync(join(parent, "external.md"), "utf8")).toBe("external");
  });

  it("U-PADM-058: finalize前のparent rename差し替えを外部directoryへ触れず拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    const parent = join(f.root, "docs", "plans");
    renameSync(parent, `${parent}-published`);
    mkdirSync(parent);
    writeFileSync(join(parent, "external.md"), "external", "utf8");

    expect(() => f.publisher.finalize(token)).toThrow(/parent drift/);
    expect(readFileSync(join(parent, "external.md"), "utf8")).toBe("external");
  });

  it("U-PADM-059: stage後にtemporary fileを同内容の別fileへ交換してもidentity CASで拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    const temporary = join(f.root, `${f.source}.ut-tdd-draft-fixture.tmp`);
    rmSync(temporary);
    writeFileSync(temporary, "new-source", "utf8");

    expect(() => f.publisher.publish(token)).toThrow(/temporary CAS/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
  });

  it("U-PADM-060: publish直前に作られたrollback補助pathを上書きしない", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    const rollback = join(f.root, `${f.source}.ut-tdd-draft-fixture.rollback`);
    writeFileSync(rollback, "foreign-rollback", "utf8");

    expect(() => f.publisher.publish(token)).toThrow();
    expect(readFileSync(rollback, "utf8")).toBe("foreign-rollback");
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("old-source");
  });

  it("U-PADM-061: target link直後の同一inode改変をpostimage CASで検出して補償する", () => {
    const f = fixture((point, path) => {
      if (point === "publish:after-target-link" && path === f.source) {
        writeFileSync(join(f.root, f.source), "tampered-postimage", "utf8");
      }
    });
    const token = f.publisher.stage(f.artifacts);

    expect(() => f.publisher.publish(token)).toThrow(/postcondition/);
    expect(() => readFileSync(join(f.root, f.source), "utf8")).toThrow();
    expect(readFileSync(join(f.root, `${f.source}.ut-tdd-draft-fixture.rollback`), "utf8")).toBe(
      "old-source",
    );
  });

  it("U-PADM-062: finalizeは外部変更されたtargetを削除処理せず拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    writeFileSync(join(f.root, f.source), "foreign-target", "utf8");

    expect(() => f.publisher.finalize(token)).toThrow(/postimage/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("foreign-target");
    expect(readFileSync(join(f.root, `${f.source}.ut-tdd-draft-fixture.rollback`), "utf8")).toBe(
      "old-source",
    );
  });

  it("U-PADM-063: finalizeは交換されたrollbackを消さずidentity CASで拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    const rollback = join(f.root, `${f.source}.ut-tdd-draft-fixture.rollback`);
    rmSync(rollback);
    writeFileSync(rollback, "old-source", "utf8");

    expect(() => f.publisher.finalize(token)).toThrow(/rollback CAS/);
    expect(readFileSync(rollback, "utf8")).toBe("old-source");
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
  });

  it("U-PADM-064: stage失敗cleanupは一件目で止まらず全artifactの失敗を集約する", () => {
    const f = fixture((point, path) => {
      if (point !== "stage:after-write" || path !== f.projection) return;
      renameSync(join(f.root, "docs", "plans"), join(f.root, "docs", "plans-moved"));
      mkdirSync(join(f.root, "docs", "plans"));
      renameSync(join(f.root, "docs", "governance"), join(f.root, "docs", "governance-moved"));
      mkdirSync(join(f.root, "docs", "governance"));
      throw new Error("stage fault");
    });

    try {
      f.publisher.stage(f.artifacts);
      throw new Error("expected AggregateError");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(3);
    }
  });

  it("U-PADM-065: durable cleanup capabilityを新process相当publisherで再開・再証明できる", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    const operation = f.publisher.describeCleanup(token, preimage("request").digest);
    const restarted = new NodeAtomicDraftPublisher({ rootDir: f.root });

    restarted.resumeCleanup(operation);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
    expect(readdirSync(join(f.root, "docs", "plans"))).toEqual(["PLAN-L7-999.md"]);
    expect(() => restarted.resumeCleanup(operation)).not.toThrow();
  });

  it("U-PADM-066: durable cleanup capabilityのroot/token外補助pathを拒否する", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);
    f.publisher.publish(token);
    const operation = f.publisher.describeCleanup(token, preimage("request").digest);
    const malicious = {
      ...operation,
      artifacts: [
        { ...operation.artifacts[0], rollbackPath: join(f.root, "foreign") },
        operation.artifacts[1],
      ] as const,
    };

    expect(() =>
      new NodeAtomicDraftPublisher({ rootDir: f.root }).resumeCleanup(malicious),
    ).toThrow(/token\/root/);
    expect(readFileSync(join(f.root, f.source), "utf8")).toBe("new-source");
  });

  it("U-PADM-067: Node path syscallの保証限界とfail-close戦略を型付き契約で公開する", () => {
    expect(NODE_PATH_MUTATION_SAFETY).toEqual({
      dirfdRelativeMutation: false,
      strategy: "pre-post-identity-cas-with-verified-compensation",
      detectedDrift: "fail-close",
      syscallInstantRaceClosure: "not-provable-with-node-fs",
      contentCas: "same-volume-generation-hardlink-pin-with-pre-post-name-binding",
    });
  });

  it("U-PADM-068: target削除後の補償失敗でもstateを確定しprimaryと補償原因を保持する", () => {
    let parentMoved = false;
    const f = fixture((point, path) => {
      if (point === "publish:after-target-link" && path === f.source) {
        writeFileSync(join(f.root, f.source), "tampered-postimage", "utf8");
      }
      if (point === "publish:after-target-compensation-remove" && path === f.source) {
        const parent = join(f.root, "docs", "plans");
        renameSync(parent, `${parent}-moved`);
        mkdirSync(parent);
        parentMoved = true;
      }
    });
    const token = f.publisher.stage(f.artifacts);

    try {
      f.publisher.publish(token);
      throw new Error("expected AggregateError");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
    }
    expect(parentMoved).toBe(true);
    expect(() => f.publisher.dispose(token)).not.toThrow();
    expect(() => f.publisher.restore(token)).toThrow(/未知または別publisher/);
  });

  it("U-PADM-069: terminal disposeは未完了tokenを再利用不能にする", () => {
    const f = fixture();
    const token = f.publisher.stage(f.artifacts);

    expect(() => f.publisher.dispose(token)).not.toThrow();
    expect(() => f.publisher.publish(token)).toThrow(/未知または別publisher/);
  });
});

function preimage(content: string) {
  return {
    kind: "sha256" as const,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const,
  };
}
