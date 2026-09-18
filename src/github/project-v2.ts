import { execFileSync } from "node:child_process";
import type { ForwardReadinessRow } from "../kernel/forward-readiness.ts";
import { stableId } from "../stable-id.ts";
import { recordGithubBinding } from "../state-db/github-forward-projection.ts";
import type { HarnessDb } from "../state-db/index.ts";

export interface ProjectField {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string }>;
}

export interface ProjectItem {
  id: string;
  title: string;
  planId: string;
  fields: Record<string, string | number>;
}

export interface ProjectSnapshot {
  id: string;
  fields: ProjectField[];
  items: ProjectItem[];
}

export interface ProjectV2Port {
  inspect(owner: string, projectNumber: number): ProjectSnapshot;
  createDraft(input: ProjectDraftInput): string;
  setText(input: ProjectFieldValue<string>): void;
  setNumber(input: ProjectFieldValue<number>): void;
  setSingleSelect(input: ProjectFieldValue<string>): void;
  clear(input: ProjectFieldTarget): void;
}

export interface ProjectDraftInput {
  owner: string;
  projectNumber: number;
  title: string;
  body: string;
}

export interface ProjectFieldTarget {
  projectId: string;
  itemId: string;
  fieldId: string;
}

export interface ProjectFieldValue<T> extends ProjectFieldTarget {
  value: T;
}

export interface GhCommandPort {
  json(args: readonly string[]): unknown;
  run(args: readonly string[]): void;
}

export class NodeGhCommandPort implements GhCommandPort {
  json(args: readonly string[]): unknown {
    const output = execFileSync("gh", [...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output);
  }

  run(args: readonly string[]): void {
    execFileSync("gh", [...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonicalFieldValues(
  item: Record<string, unknown>,
  fields: readonly ProjectField[],
): Record<string, string | number> {
  const scalarEntries = Object.entries(item).filter(
    (entry): entry is [string, string | number] =>
      typeof entry[1] === "string" || typeof entry[1] === "number",
  );
  return Object.fromEntries(
    fields.flatMap((field) => {
      const exact = scalarEntries.find(([key]) => key === field.name);
      const asciiFold = scalarEntries.find(
        ([key]) => key.toLocaleLowerCase() === field.name.toLocaleLowerCase(),
      );
      const suffix =
        field.name.length > 1
          ? scalarEntries.find(([key]) => key.endsWith(field.name.slice(1)))
          : undefined;
      const match = exact ?? asciiFold ?? suffix;
      return match ? [[field.name, match[1]]] : [];
    }),
  );
}

export class GhProjectV2Adapter implements ProjectV2Port {
  readonly #gh: GhCommandPort;

  constructor(gh: GhCommandPort = new NodeGhCommandPort()) {
    this.#gh = gh;
  }

  inspect(owner: string, projectNumber: number): ProjectSnapshot {
    const project = object(
      this.#gh.json([
        "project",
        "view",
        String(projectNumber),
        "--owner",
        owner,
        "--format",
        "json",
      ]),
    );
    const fieldsPayload = object(
      this.#gh.json([
        "project",
        "field-list",
        String(projectNumber),
        "--owner",
        owner,
        "--limit",
        "100",
        "--format",
        "json",
      ]),
    );
    const itemsPayload = object(
      this.#gh.json([
        "project",
        "item-list",
        String(projectNumber),
        "--owner",
        owner,
        "--limit",
        "1000",
        "--format",
        "json",
      ]),
    );
    const fields = list(fieldsPayload.fields).map((value) => {
      const field = object(value);
      return {
        id: String(field.id ?? ""),
        name: String(field.name ?? ""),
        type: String(field.type ?? ""),
        options: list(field.options).map((optionValue) => {
          const option = object(optionValue);
          return { id: String(option.id ?? ""), name: String(option.name ?? "") };
        }),
      };
    });
    return {
      id: String(project.id ?? ""),
      fields,
      items: list(itemsPayload.items).map((value) => {
        const item = object(value);
        const itemTitle = String(item.title ?? "");
        const titlePlanId =
          itemTitle.match(/^(PLAN-[A-Z0-9]+-[0-9A-Za-z][0-9A-Za-z-]*)/)?.[1] ?? "";
        return {
          id: String(item.id ?? ""),
          title: itemTitle,
          planId: String(item["PLAN ID"] ?? "") || titlePlanId,
          fields: canonicalFieldValues(item, fields),
        };
      }),
    };
  }

  createDraft(input: ProjectDraftInput): string {
    const result = object(
      this.#gh.json([
        "project",
        "item-create",
        String(input.projectNumber),
        "--owner",
        input.owner,
        "--title",
        input.title,
        "--body",
        input.body,
        "--format",
        "json",
      ]),
    );
    const id = String(result.id ?? "");
    if (!id) throw new Error("GitHub Project item-create returned no id");
    return id;
  }

  setText(input: ProjectFieldValue<string>): void {
    this.#edit(input, ["--text", input.value]);
  }

  setNumber(input: ProjectFieldValue<number>): void {
    this.#edit(input, ["--number", String(input.value)]);
  }

  setSingleSelect(input: ProjectFieldValue<string>): void {
    this.#edit(input, ["--single-select-option-id", input.value]);
  }

  clear(input: ProjectFieldTarget): void {
    this.#edit(input, ["--clear"]);
  }

  #edit(input: ProjectFieldTarget, valueArgs: string[]): void {
    this.#gh.run([
      "project",
      "item-edit",
      "--project-id",
      input.projectId,
      "--id",
      input.itemId,
      "--field-id",
      input.fieldId,
      ...valueArgs,
    ]);
  }
}

export interface ProjectMutation {
  kind: "create" | "update";
  planId: string;
  itemId: string;
  field: string;
  value: string | number;
}

export interface ProjectSyncResult {
  applied: boolean;
  projectId: string;
  mutations: ProjectMutation[];
  itemIds: Record<string, string>;
}

function title(row: ForwardReadinessRow): string {
  return `${row.planId}: ${row.currentGate}`;
}

function desiredFields(row: ForwardReadinessRow): Record<string, string | number> {
  return {
    "PLAN ID": row.planId,
    Vモデル層: row.layer || "cross",
    実行状態: row.readiness,
    現在ゲート: row.currentGate,
    実装順序: row.implementationOrder,
    先行PLAN: row.predecessorPlanIds.join(", "),
    阻害要因: row.blockedReason,
    解除条件: row.unlockCondition,
    次の作業: row.nextPlanIds.join(", "),
    解放される後続: row.unlockedPlanIds.join(", "),
    CI状態: row.ci,
    レビュー状態: row.review,
    対象HEAD: row.headSha,
    同期状態: row.sync,
  };
}

function assertProjectContract(
  snapshot: ProjectSnapshot,
  rows: readonly ForwardReadinessRow[],
): Map<string, ProjectField> {
  if (!snapshot.id) throw new Error("GitHub Project id is missing");
  const fields = new Map(snapshot.fields.map((field) => [field.name, field]));
  const missing = Object.keys(
    desiredFields({
      planId: "PLAN-L0-0-contract",
      revision: "contract",
      layer: "L0",
      readiness: "保留",
      currentGate: "plan",
      implementationOrder: 0,
      predecessorPlanIds: [],
      blockedReason: "",
      unlockCondition: "",
      nextPlanIds: [],
      unlockedPlanIds: [],
      headSha: "",
      ci: "未実行",
      review: "未依頼",
      sync: "未同期",
    }),
  ).filter((name) => !fields.has(name));
  if (missing.length > 0) throw new Error(`GitHub Project fields missing: ${missing.join(", ")}`);
  for (const row of rows) {
    for (const [fieldName, value] of Object.entries(desiredFields(row))) {
      const field = fields.get(fieldName);
      if (field?.type !== "ProjectV2SingleSelectField" || String(value) === "") continue;
      if (!field.options?.some((candidate) => candidate.name === String(value)))
        throw new Error(`field option missing: ${fieldName}=${value}`);
    }
  }
  return fields;
}

export function syncForwardProject(input: {
  rows: readonly ForwardReadinessRow[];
  owner: string;
  projectNumber: number;
  port: ProjectV2Port;
  apply: boolean;
}): ProjectSyncResult {
  const snapshot = input.port.inspect(input.owner, input.projectNumber);
  const inconsistent = input.rows.filter((row) => row.sync === "不整合");
  if (input.apply && inconsistent.length > 0)
    throw new Error(
      `GitHub Project sync is inconsistent: ${inconsistent.map((row) => row.planId).join(", ")}`,
    );
  const fields = assertProjectContract(snapshot, input.rows);
  const duplicates = new Set<string>();
  const byPlan = new Map<string, ProjectItem>();
  for (const item of snapshot.items) {
    if (!item.planId) continue;
    if (byPlan.has(item.planId)) duplicates.add(item.planId);
    byPlan.set(item.planId, item);
  }
  if (duplicates.size > 0)
    throw new Error(`duplicate GitHub Project items: ${[...duplicates].sort().join(", ")}`);
  const mutations: ProjectMutation[] = [];
  const itemIds: Record<string, string> = {};
  for (const row of input.rows) {
    const existing = byPlan.get(row.planId);
    let itemId = existing?.id ?? "";
    if (!itemId) {
      mutations.push({
        kind: "create",
        planId: row.planId,
        itemId: "",
        field: "Title",
        value: title(row),
      });
      if (input.apply)
        itemId = input.port.createDraft({
          owner: input.owner,
          projectNumber: input.projectNumber,
          title: title(row),
          body: `HARNESS DB projection\n\nPLAN: ${row.planId}\nRevision: ${row.revision}`,
        });
      else itemId = `dry-run:${row.planId}`;
    }
    itemIds[row.planId] = itemId;
    for (const [fieldName, value] of Object.entries(desiredFields(row))) {
      if (existing && String(existing.fields[fieldName] ?? "").trim() === String(value).trim())
        continue;
      mutations.push({ kind: "update", planId: row.planId, itemId, field: fieldName, value });
      if (!input.apply) continue;
      const field = fields.get(fieldName);
      if (!field) throw new Error(`field disappeared during sync: ${fieldName}`);
      const target = { projectId: snapshot.id, itemId, fieldId: field.id };
      if (String(value) === "") input.port.clear(target);
      else if (fieldName === "実装順序") input.port.setNumber({ ...target, value: Number(value) });
      else if (field.type === "ProjectV2SingleSelectField") {
        const option = field.options?.find((candidate) => candidate.name === String(value));
        if (!option) throw new Error(`field option missing: ${fieldName}=${value}`);
        input.port.setSingleSelect({ ...target, value: option.id });
      } else input.port.setText({ ...target, value: String(value) });
    }
  }
  return { applied: input.apply, projectId: snapshot.id, mutations, itemIds };
}

export function persistProjectSync(input: {
  db: HarnessDb;
  repositoryId: string;
  projectId: string;
  rows: readonly ForwardReadinessRow[];
  result: ProjectSyncResult;
  outboxIds: readonly string[];
  now?: string;
}): void {
  if (input.rows.length !== input.outboxIds.length)
    throw new Error("project sync outbox custody mismatch");
  const now = input.now ?? new Date().toISOString();
  const statement = input.db.prepare(
    `INSERT INTO github_project_item_projection (
       projection_id, repository_id, project_id, project_item_id, plan_id,
       plan_revision, content_node_id, head_sha, sync_status, last_reconciled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, plan_id, plan_revision) DO UPDATE SET
       project_id=excluded.project_id, project_item_id=excluded.project_item_id,
       head_sha=excluded.head_sha, sync_status=excluded.sync_status,
       last_reconciled_at=excluded.last_reconciled_at`,
  );
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const currentOutbox = input.db.prepare(
      `SELECT outbox_id, status FROM github_projection_outbox
        WHERE repository_id = ? AND plan_id = ? AND plan_revision = ?
          AND operation = 'project-item-upsert'`,
    );
    const applyOutbox = input.db.prepare(
      `UPDATE github_projection_outbox
          SET status = 'applied', attempt_count = attempt_count + 1,
              last_error = '', updated_at = ?
        WHERE outbox_id = ? AND status = 'applying'`,
    );
    for (const [index, row] of input.rows.entries()) {
      const outboxId = input.outboxIds[index] ?? "";
      const custody = currentOutbox.get(input.repositoryId, row.planId, row.revision);
      if (custody?.outbox_id !== outboxId || custody?.status !== "applying")
        throw new Error(`stale project sync completion: ${row.planId}`);
      const itemId = input.result.itemIds[row.planId] ?? "";
      statement.run(
        stableId("github-project-item", `${input.repositoryId}:${row.planId}:${row.revision}`),
        input.repositoryId,
        input.projectId,
        itemId,
        row.planId,
        row.revision,
        "",
        row.headSha,
        input.result.applied ? "同期済" : "未同期",
        now,
      );
      if (input.result.applied && itemId) {
        recordGithubBinding(input.db, {
          repositoryId: input.repositoryId,
          planId: row.planId,
          planRevision: row.revision,
          projectItemId: itemId,
          objectKind: "project_item",
          objectId: itemId,
          state: "同期済",
          observedAt: now,
        });
      }
      applyOutbox.run(now, outboxId);
    }
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }
}
