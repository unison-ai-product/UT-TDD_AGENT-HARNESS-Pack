import { describe, expect, it } from "vitest";
import type {
  GhCommandPort,
  ProjectField,
  ProjectSnapshot,
  ProjectV2Port,
} from "../src/github/project-v2.ts";
import {
  GhProjectV2Adapter,
  persistProjectSync,
  syncForwardProject,
} from "../src/github/project-v2.ts";
import type { ForwardReadinessRow } from "../src/kernel/forward-readiness.ts";
import {
  claimGithubProjection,
  queueGithubProjection,
} from "../src/state-db/github-forward-projection.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

const select = (name: string, options: string[]): ProjectField => ({
  id: `field:${name}`,
  name,
  type: "ProjectV2SingleSelectField",
  options: options.map((option) => ({ id: `option:${name}:${option}`, name: option })),
});

const fields: ProjectField[] = [
  ...[
    "PLAN ID",
    "現在ゲート",
    "先行PLAN",
    "阻害要因",
    "解除条件",
    "次の作業",
    "解放される後続",
    "対象HEAD",
  ].map((name) => ({ id: `field:${name}`, name, type: "ProjectV2Field" })),
  { id: "field:実装順序", name: "実装順序", type: "ProjectV2Field" },
  select("Vモデル層", ["L7", "cross"]),
  select("実行状態", ["着手可能", "進行中", "阻害中", "保留", "レビュー中", "完了"]),
  select("CI状態", ["未実行", "実行中", "成功", "失敗", "取消"]),
  select("レビュー状態", ["未依頼", "依頼中", "承認", "要修正"]),
  select("同期状態", ["同期済", "遅延", "不整合", "未同期"]),
];

class FakeProjectPort implements ProjectV2Port {
  snapshot: ProjectSnapshot = { id: "project:6", fields, items: [] };
  calls: string[] = [];
  inspect(): ProjectSnapshot {
    return this.snapshot;
  }
  createDraft(input: Parameters<ProjectV2Port["createDraft"]>[0]): string {
    this.calls.push(`create:${input.title}`);
    return "item:new";
  }
  setText(input: Parameters<ProjectV2Port["setText"]>[0]): void {
    this.calls.push(`text:${input.fieldId}:${input.value}`);
  }
  setNumber(input: Parameters<ProjectV2Port["setNumber"]>[0]): void {
    this.calls.push(`number:${input.fieldId}:${input.value}`);
  }
  setSingleSelect(input: Parameters<ProjectV2Port["setSingleSelect"]>[0]): void {
    this.calls.push(`select:${input.fieldId}:${input.value}`);
  }
  clear(input: Parameters<ProjectV2Port["clear"]>[0]): void {
    this.calls.push(`clear:${input.fieldId}`);
  }
}

const row: ForwardReadinessRow = {
  planId: "PLAN-L7-436-domain",
  revision: "rev1",
  layer: "L7",
  readiness: "着手可能",
  currentGate: "plan",
  implementationOrder: 1,
  predecessorPlanIds: [],
  blockedReason: "",
  unlockCondition: "",
  nextPlanIds: ["PLAN-L7-437-adapter"],
  unlockedPlanIds: [],
  headSha: "",
  ci: "未実行",
  review: "未依頼",
  sync: "未同期",
};

describe("GitHub Project V2 reconciler", () => {
  it("U-GHPROJ-019: canonicalizes gh CLI custom field key mangling", () => {
    let call = 0;
    const gh: GhCommandPort = {
      json: () => {
        call += 1;
        if (call === 1) return { id: "project:6" };
        if (call === 2)
          return {
            fields: [
              { id: "p", name: "PLAN ID", type: "ProjectV2Field" },
              { id: "b", name: "阻害要因", type: "ProjectV2Field" },
            ],
          };
        return {
          items: [
            {
              id: "item:1",
              title: "PLAN-L7-436-domain",
              "pLAN ID": "PLAN-L7-436-domain",
              "���害要因": "blocked",
            },
          ],
        };
      },
      run: () => undefined,
    };
    expect(new GhProjectV2Adapter(gh).inspect("owner", 6).items[0]).toMatchObject({
      planId: "PLAN-L7-436-domain",
      fields: { "PLAN ID": "PLAN-L7-436-domain", 阻害要因: "blocked" },
    });
  });

  it("U-GHPROJ-020: dry-run plans the same fields without mutations", () => {
    const port = new FakeProjectPort();
    const result = syncForwardProject({
      rows: [row],
      owner: "owner",
      projectNumber: 6,
      port,
      apply: false,
    });
    expect(port.calls).toEqual([]);
    expect(result.mutations).toHaveLength(15);
    expect(result.itemIds[row.planId]).toBe(`dry-run:${row.planId}`);
    expect(result.mutations).toContainEqual({
      kind: "update",
      planId: row.planId,
      itemId: `dry-run:${row.planId}`,
      field: "同期状態",
      value: "未同期",
    });
  });

  it("U-GHPROJ-020a: dry-run preserves a detected synchronization inconsistency", () => {
    const port = new FakeProjectPort();
    const inconsistent = { ...row, sync: "不整合" as const };
    const result = syncForwardProject({
      rows: [inconsistent],
      owner: "owner",
      projectNumber: 6,
      port,
      apply: false,
    });
    expect(result.mutations).toContainEqual({
      kind: "update",
      planId: row.planId,
      itemId: `dry-run:${row.planId}`,
      field: "同期状態",
      value: "不整合",
    });
  });

  it("U-GHPROJ-021: apply creates once and updates typed fields", () => {
    const port = new FakeProjectPort();
    const result = syncForwardProject({
      rows: [row],
      owner: "owner",
      projectNumber: 6,
      port,
      apply: true,
    });
    expect(result.itemIds[row.planId]).toBe("item:new");
    expect(port.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(port.calls).toContain("number:field:実装順序:1");
    expect(port.calls).toContain("select:field:実行状態:option:実行状態:着手可能");
  });

  it("U-GHPROJ-023: existing equal item is a no-op", () => {
    const port = new FakeProjectPort();
    port.snapshot.items = [
      {
        id: "item:existing",
        title: row.planId,
        planId: row.planId,
        fields: {
          "PLAN ID": row.planId,
          Vモデル層: row.layer,
          実行状態: row.readiness,
          現在ゲート: row.currentGate,
          実装順序: row.implementationOrder,
          先行PLAN: "",
          阻害要因: "",
          解除条件: "",
          次の作業: row.nextPlanIds.join(", "),
          解放される後続: "",
          CI状態: row.ci,
          レビュー状態: row.review,
          対象HEAD: "",
          同期状態: "未同期",
        },
      },
    ];
    const result = syncForwardProject({
      rows: [row],
      owner: "owner",
      projectNumber: 6,
      port,
      apply: true,
    });
    expect(result.mutations).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("U-GHPROJ-022: fails closed on duplicate items and missing fields", () => {
    const duplicatePort = new FakeProjectPort();
    duplicatePort.snapshot.items = [
      { id: "a", title: "a", planId: row.planId, fields: {} },
      { id: "b", title: "b", planId: row.planId, fields: {} },
    ];
    expect(() =>
      syncForwardProject({
        rows: [row],
        owner: "owner",
        projectNumber: 6,
        port: duplicatePort,
        apply: false,
      }),
    ).toThrow(/duplicate/);
    const missingPort = new FakeProjectPort();
    missingPort.snapshot.fields = [];
    expect(() =>
      syncForwardProject({
        rows: [row],
        owner: "owner",
        projectNumber: 6,
        port: missingPort,
        apply: false,
      }),
    ).toThrow(/fields missing/);
  });

  it("U-GHPROJ-024: persists Project item identity as a durable binding", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const persistedRow = { ...row, headSha: "abc1234" };
      const outboxId = queueGithubProjection({
        db,
        repositoryId: "owner/repo",
        planId: row.planId,
        planRevision: row.revision,
        operation: "project-item-upsert",
        payload: {
          owner: "owner",
          projectNumber: 6,
          readiness: persistedRow.readiness,
          currentGate: persistedRow.currentGate,
          headSha: persistedRow.headSha,
        },
      });
      claimGithubProjection(db, [outboxId]);
      persistProjectSync({
        db,
        repositoryId: "owner/repo",
        projectId: "project:6",
        rows: [persistedRow],
        result: {
          applied: true,
          projectId: "project:6",
          mutations: [],
          itemIds: { [row.planId]: "item:1" },
        },
        outboxIds: [outboxId],
      });
      expect(
        db.prepare("SELECT object_kind, object_id, state FROM github_object_bindings").get(),
      ).toEqual({ object_kind: "project_item", object_id: "item:1", state: "同期済" });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-048/U-GHPROJ-049: serializes remote intent and completes projection atomically", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      const persistedRow = { ...row, headSha: "abc1234" };
      const input = {
        db,
        repositoryId: "owner/repo",
        planId: row.planId,
        planRevision: row.revision,
        operation: "project-item-upsert" as const,
        payload: {
          owner: "owner",
          projectNumber: 6,
          readiness: persistedRow.readiness,
          currentGate: persistedRow.currentGate,
          headSha: persistedRow.headSha,
        },
      };
      const outboxId = queueGithubProjection(input);
      claimGithubProjection(db, [outboxId]);
      expect(() =>
        queueGithubProjection({
          ...input,
          payload: { ...input.payload, currentGate: "review", headSha: "def5678" },
        }),
      ).toThrow(/already applying/);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM github_project_item_projection").get(),
      ).toEqual({ count: 0 });
      persistProjectSync({
        db,
        repositoryId: "owner/repo",
        projectId: "project:6",
        rows: [persistedRow],
        result: {
          applied: true,
          projectId: "project:6",
          mutations: [],
          itemIds: { [row.planId]: "item:1" },
        },
        outboxIds: [outboxId],
      });
      expect(
        db.prepare("SELECT status, attempt_count FROM github_projection_outbox").get(),
      ).toEqual({ status: "applied", attempt_count: 1 });
      expect(
        db.prepare("SELECT head_sha, sync_status FROM github_project_item_projection").get(),
      ).toEqual({ head_sha: persistedRow.headSha, sync_status: "同期済" });
    } finally {
      db.close();
    }
  });

  it("U-GHPROJ-025: apply fails closed while DB reports inconsistent sync", () => {
    const port = new FakeProjectPort();
    expect(() =>
      syncForwardProject({
        rows: [{ ...row, sync: "不整合" }],
        owner: "owner",
        projectNumber: 6,
        port,
        apply: true,
      }),
    ).toThrow(/inconsistent/);
    expect(port.calls).toEqual([]);
  });

  it("U-GHPROJ-026: validates select options before the first remote mutation", () => {
    const port = new FakeProjectPort();
    port.snapshot.fields = fields.map((field) =>
      field.name === "同期状態"
        ? {
            ...field,
            options: field.options?.filter((option) => option.name !== "未同期"),
          }
        : field,
    );
    expect(() =>
      syncForwardProject({
        rows: [row],
        owner: "owner",
        projectNumber: 6,
        port,
        apply: true,
      }),
    ).toThrow(/field option missing: 同期状態=未同期/);
    expect(port.calls).toEqual([]);
  });
});
