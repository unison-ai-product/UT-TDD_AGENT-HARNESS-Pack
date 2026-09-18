import { describe, expect, it } from "vitest";
import { openHarnessDb, upsertRow } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { buildScopeDryRunPreview } from "../src/state-db/scope-preview.ts";

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

function insertActivationReview(
  db: ReturnType<typeof openHarnessDb>,
  input: Record<string, unknown>,
) {
  upsertRow(db, {
    table: "activation_schedule_reviews",
    primaryKey: "activation_schedule_review_id",
    row: {
      activation_schedule_review_id: `${input.profile_id}:${input.plan_id}`,
      profile_id: input.profile_id,
      plan_id: input.plan_id,
      schedule_entry_id: `schedule:${input.plan_id}`,
      activation_entry_id: `activation:${input.profile_id}:${input.plan_id}`,
      target_kind: "plan",
      target_id: input.plan_id,
      scope_status: input.scope_status,
      enabled: input.enabled,
      target_version: "fixture",
      defer_reason: input.defer_reason ?? "",
      current_location: input.current_location,
      rag: input.rag,
      schedule_status: input.schedule_status,
      layer: input.layer,
      sub_doc: input.sub_doc ?? "",
      v_pair: input.v_pair ?? "",
      source_path: "docs/governance/vmodel-activation-profiles.md",
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
      upsertRow(db, {
        table: "plan_registry",
        primaryKey: "plan_id",
        row: {
          plan_id: "PLAN-L4-16-security-design-slot",
          kind: "add-design",
          layer: "L4",
          status: "draft",
        },
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
            required_action: "follow required plan PLAN-L4-16-security-design-slot",
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

  it("reports missing profiles and unresolved required plans as dry-run findings", () => {
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
      expect(enterprise.findings).toEqual([
        expect.objectContaining({
          kind: "scope-preview-required-plan-missing",
          severity: "warn",
        }),
      ]);
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

  it("surfaces activation rows, empty activation options, and unknown decisions", () => {
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
      insertActivationReview(db, {
        profile_id: "vmodel-clean-core",
        plan_id: "PLAN-L0-01-vmodel-harness-upgrade-charter",
        scope_status: "in_scope",
        enabled: 1,
        current_location: "U0 fixture",
        rag: "green",
        schedule_status: "confirmed",
        layer: "L0",
        sub_doc: "charter",
      });

      const result = buildScopeDryRunPreview(db, {
        profileId: "enterprise",
        activationProfileId: "vmodel-clean-core",
      });
      const emptyActivation = buildScopeDryRunPreview(db, {
        profileId: "enterprise",
        activationProfileId: "   ",
      });

      expect(result.activations).toEqual([
        expect.objectContaining({
          profile_id: "vmodel-clean-core",
          plan_id: "PLAN-L0-01-vmodel-harness-upgrade-charter",
          gate_id: "G0.5",
        }),
      ]);
      expect(result.detectors).toContain("activation-schedule-review");
      expect(result.findings).toEqual([
        expect.objectContaining({ kind: "scope-preview-document-decision-unknown" }),
      ]);
      expect(emptyActivation.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "scope-preview-activation-profile-empty" }),
          expect.objectContaining({ kind: "scope-preview-document-decision-unknown" }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
