import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";
import { buildScopeDryRunPreview } from "../src/state-db/scope-preview.ts";
import { frozenSchema } from "./support/plan-mechanism-retirement-s3-migration.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function insertDocumentReview(
  db: ReturnType<typeof openHarnessDb>,
  input: Record<string, unknown>,
) {
  upsertRow(db, {
    table: "document_scale_profile_reviews",
    primaryKey: "document_scale_profile_review_id",
    row: {
      document_scale_profile_review_id: `${input.profile_id}:${input.doc_type_id}`,
      profile_id: input.profile_id,
      doc_type_id: input.doc_type_id,
      document_scale_profile_entry_id: `entry:${input.profile_id}:${input.doc_type_id}`,
      document_catalog_entry_id: `catalog:${input.doc_type_id}`,
      decision: input.decision,
      detail_override: input.detail_override,
      status_override: input.status_override,
      reason: input.reason ?? "",
      required_plan_id: input.required_plan_id ?? "",
      catalog_layer: input.catalog_layer,
      catalog_sub_doc: input.catalog_sub_doc,
      requirement_class: input.requirement_class ?? "product-select",
      catalog_default_status: input.catalog_default_status ?? "skipped",
      catalog_profile_controlled: 1,
      catalog_skip_reason_required: 1,
      source_path: "docs/governance/vmodel-document-scale-profiles.md",
      indexed_at: "2026-07-09T00:00:00.000Z",
    },
  });
}

describe("scope dry-run preview", () => {
  it("resolves document scale profile decisions without mutating source truth", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertDocumentReview(db, {
        profile_id: "standard",
        doc_type_id: "DOC-L4-REPORT",
        decision: "conditional",
        detail_override: "standard",
        status_override: "profile_controlled",
        reason: "report capability flag controls adoption",
        catalog_layer: "L4",
        catalog_sub_doc: "report",
      });
      insertDocumentReview(db, {
        profile_id: "standard",
        doc_type_id: "DOC-L4-SECURITY",
        decision: "defer",
        detail_override: "standard",
        status_override: "draft",
        reason: "security slot is handled by a dedicated PLAN",
        required_plan_id: "PLAN-L4-16-security-design-slot",
        catalog_layer: "L4",
        catalog_sub_doc: "security",
      });

      const result = buildScopeDryRunPreview(db, {
        profileId: "standard",
        capabilityFlags: ["report"],
      });

      expect(result.ok).toBe(true);
      expect(result.summary).toMatchObject({
        documents_total: 2,
        documents_in_scope: 1,
        documents_deferred: 1,
      });
      expect(result.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            doc_type_id: "DOC-L4-REPORT",
            resolved_scope_status: "in_scope",
            gate_id: "G4",
          }),
          expect.objectContaining({
            doc_type_id: "DOC-L4-SECURITY",
            resolved_scope_status: "deferred",
            required_action: "route defer target before implementation",
          }),
        ]),
      );
      expect(result.gates).toEqual(["G4"]);
      expect(result.detectors).toEqual([
        "document-catalog",
        "document-scale-profile",
        "spec-ir-integrity",
      ]);
      expect(result.findings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reports missing profiles and does not resolve required_plan_id against PLAN projections", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertDocumentReview(db, {
        profile_id: "enterprise",
        doc_type_id: "DOC-L4-SECURITY",
        decision: "defer",
        detail_override: "detailed",
        status_override: "draft",
        reason: "security slot is handled by a dedicated PLAN",
        required_plan_id: "PLAN-L4-16-security-design-slot",
        catalog_layer: "L4",
        catalog_sub_doc: "security",
      });

      const enterprise = buildScopeDryRunPreview(db, { profileId: "enterprise" });
      const missing = buildScopeDryRunPreview(db, { profileId: "missing-profile" });

      expect(enterprise.ok).toBe(true);
      expect(enterprise.findings).toEqual([]);
      expect(enterprise.documents[0]).not.toHaveProperty("required_plan_id");
      expect(missing.ok).toBe(false);
      expect(missing.findings).toEqual([
        expect.objectContaining({
          kind: "scope-preview-profile-missing",
          severity: "error",
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves legacy schedule data through rebuild and returns the same document preview", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ut-tdd-scope-preview-legacy-db-"));
    const fresh = openHarnessDb(":memory:", { repoRoot });
    const legacy = openHarnessDb(":memory:", { repoRoot });
    try {
      const governance = join(repoRoot, "docs", "governance");
      mkdirSync(governance, { recursive: true });
      writeFileSync(
        join(governance, "vmodel-document-catalog.md"),
        [
          "# Document catalog",
          "| doc_type_id | layer | sub_doc | category | requirement_class | applicability | default_status |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| DOC-L4-REPORT | L4 | report | deliverable | product-select | profile_controlled | skipped |",
        ].join("\n"),
        "utf8",
      );
      const tables = ["schedule_entries", "activation_entries", "activation_schedule_reviews"];
      const legacyDdls = frozenSchema().schemaDdls.filter((ddl) =>
        tables.some(
          (table) =>
            ddl.startsWith("CREATE TABLE IF NOT EXISTS " + table + " (") ||
            (ddl.startsWith("CREATE INDEX ") && ddl.includes(" ON " + table + " (")),
        ),
      );
      expect(legacyDdls).toHaveLength(9);
      for (const ddl of legacyDdls) legacy.exec(ddl);
      legacy
        .prepare(
          "INSERT INTO schedule_entries (schedule_entry_id, plan_id, layer) VALUES (?, ?, ?)",
        )
        .run("legacy-schedule", "PLAN-L0-999-legacy", "L0");
      legacy
        .prepare(
          "INSERT INTO activation_entries (activation_entry_id, profile_id, plan_id) VALUES (?, ?, ?)",
        )
        .run("legacy-activation", "fixture", "PLAN-L0-999-legacy");
      legacy
        .prepare(
          "INSERT INTO activation_schedule_reviews (activation_schedule_review_id, profile_id, plan_id, schedule_entry_id, activation_entry_id, layer) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "legacy-join",
          "fixture",
          "PLAN-L0-999-legacy",
          "legacy-schedule",
          "legacy-activation",
          "L0",
        );

      const schemaRows = (db: typeof legacy) =>
        db
          .prepare(
            "SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (?, ?, ?) AND sql IS NOT NULL ORDER BY name",
          )
          .all(...tables);
      const legacyRows = () =>
        tables.map((table) => legacy.prepare("SELECT * FROM " + table).all());
      const beforeSchema = schemaRows(legacy);
      const beforeRows = legacyRows();
      expect(beforeSchema).toHaveLength(9);
      expect(beforeRows.map((rows) => rows.length)).toEqual([1, 1, 1]);

      for (const db of [fresh, legacy]) {
        rebuildHarnessDb({ repoRoot, db, skipTokenTelemetry: true });
        expect(db.prepare("SELECT doc_type_id FROM document_catalog_entries").all()).toEqual([
          { doc_type_id: "DOC-L4-REPORT" },
        ]);
        insertDocumentReview(db, {
          profile_id: "fixture",
          doc_type_id: "DOC-L4-REPORT",
          decision: "conditional",
          detail_override: "standard",
          status_override: "profile_controlled",
          reason: "report capability",
          catalog_layer: "L4",
          catalog_sub_doc: "report",
        });
      }

      const input = { profileId: "fixture", capabilityFlags: ["report"] };
      const preview = buildScopeDryRunPreview(fresh, input);
      expect(preview).toMatchObject({
        ok: true,
        gates: ["G4"],
        detectors: ["document-catalog", "document-scale-profile", "spec-ir-integrity"],
        findings: [],
        documents: [
          expect.objectContaining({
            doc_type_id: "DOC-L4-REPORT",
            resolved_scope_status: "in_scope",
          }),
        ],
        summary: { documents_total: 1, documents_in_scope: 1 },
      });
      expect(buildScopeDryRunPreview(legacy, input)).toEqual(preview);
      expect(preview).not.toHaveProperty("activations");
      expect(preview.summary).not.toHaveProperty("activations_total");
      expect(schemaRows(fresh)).toEqual([]);
      expect(schemaRows(legacy)).toEqual(beforeSchema);
      expect(legacyRows()).toEqual(beforeRows);
    } finally {
      fresh.close();
      legacy.close();
      removeTestTree(repoRoot);
    }
  });

  it("surfaces unknown document decisions", () => {
    const db = openHarnessDb(":memory:");
    try {
      migrate(db);
      insertDocumentReview(db, {
        profile_id: "enterprise",
        doc_type_id: "DOC-L4-REPORT",
        decision: "unknown",
        detail_override: "detailed",
        status_override: "required",
        reason: "bad decision fixture",
        catalog_layer: "L4",
        catalog_sub_doc: "report",
      });
      const result = buildScopeDryRunPreview(db, { profileId: "enterprise" });

      expect(result.findings).toEqual([
        expect.objectContaining({ kind: "scope-preview-document-decision-unknown" }),
      ]);
    } finally {
      db.close();
    }
  });
});
