import { describe, expect, it } from "vitest";
import {
  analyzeDbConstraintCoverage,
  analyzeDbProjectionCoverage,
  dbProjectionCoverageMessages,
  extractDbProjectionCoverageRequirements,
  extractDbProjectionRequirements,
  loadDbProjectionRequirements,
} from "../src/lint/db-projection-coverage.ts";
import { createTableSql, type TableDef } from "../src/schema/harness-db.ts";
import {
  enumCheck,
  foreignKey,
  reference,
  requiredCol,
} from "../src/schema/harness-db-table-builders.ts";
import { openHarnessDb } from "../src/state-db/index.ts";

const parent: TableDef = {
  name: "coverage_parent",
  columns: [{ name: "id", type: "TEXT", primaryKey: true }],
};
const child: TableDef = {
  name: "coverage_child",
  columns: [
    requiredCol("parent_id"),
    requiredCol("ordinal", "INTEGER"),
    {
      ...reference("owner_id", { table: "coverage_parent", column: "id", onDelete: "CASCADE" }),
      notNull: true,
    },
    requiredCol("status"),
  ],
  primaryKey: ["parent_id", "ordinal"],
  unique: [["owner_id", "ordinal"]],
  foreignKeys: [
    foreignKey(["parent_id"], {
      table: "coverage_parent",
      columns: ["id"],
      onDelete: "RESTRICT",
    }),
  ],
  checks: [enumCheck("status", ["draft", "confirmed"])],
};

describe("db-projection-coverage detector", () => {
  it("covers physical-data projection tables and required columns with the schema registry", () => {
    const requirements = loadDbProjectionRequirements(process.cwd());
    const result = analyzeDbProjectionCoverage(requirements);

    expect(result.ok).toBe(true);
    expect(requirements.tables.map((item) => item.table)).toEqual([
      "plan_registry",
      "artifact_registry",
      "model_runs",
      "trace_edges",
      "coverage",
      "findings",
      "gate_runs",
      "drive_runs",
      "hook_events",
      "skill_invocations",
      "skill_recommendations",
      "feedback_events",
      "feedback_lifecycle",
      "memory_entries",
      "quality_signals",
      "search_index",
      "workflow_runs",
      "guardrail_decisions",
      "automation_assets",
      "issue_queue",
      "trouble_events",
      "retry_events",
      "improvement_log",
      "refactor_candidates",
      "test_cases",
      "test_runs",
      "test_results",
      "test_artifact_edges",
      "test_flake_events",
      "graph_nodes",
      "dependency_edges",
      "impact_rules",
      "impact_results",
      "artifact_progress",
      "artifact_progress_events",
      "tool_runs",
      "diagram_artifacts",
      "graph_snapshots",
      "mcp_server_profiles",
      "mcp_profile_triggers",
      "mcp_server_runs",
      "verification_profiles",
      "verification_recommendations",
      "external_tool_findings",
      "document_export_profiles",
      "document_export_runs",
      "document_export_datasets",
      "document_export_artifacts",
      "document_export_triggers",
      "screens",
      "screen_trace",
      "spec_defs",
      "spec_relations",
      "schedule_entries",
      "activation_entries",
      "activation_schedule_reviews",
      "document_catalog_entries",
      "spec_rag_closure_entries",
      "detector_route_candidates",
      "agent_contracts",
      "github_review_lane_receipts",
      "execution_readiness_projection",
      "github_project_item_projection",
      "github_object_bindings",
      "github_projection_outbox",
    ]);
    expect(requirements.indexes.map((item) => item.name)).toEqual([
      "idx_plan_layer_drive_status",
      "idx_trace_from_to",
      "idx_findings_subject_status",
      "idx_hook_session_plan",
      "idx_skill_plan_skill",
      "idx_memory_kind_updated",
      "idx_feedback_source",
      "idx_feedback_lifecycle_event",
      "idx_search_subject",
      "idx_issue_queue_plan_status",
      "idx_trouble_events_plan_category",
      "idx_retry_events_plan_phase",
      "idx_improvement_log_status",
      "idx_refactor_candidates_state",
      "idx_refactor_candidates_plan",
      "idx_graph_node_type_subject",
      "idx_graph_path",
      "idx_dependency_from_kind",
      "idx_dependency_to_kind",
      "idx_impact_change_status",
      "idx_artifact_progress_color",
      "idx_artifact_progress_tests",
      "idx_artifact_progress_events_path",
      "idx_feedback_source",
      "idx_tool_name_scope",
      "idx_diagram_scope_format",
      "idx_mcp_profile_name",
      "idx_mcp_triggers_signal",
      "idx_mcp_runs_profile_plan",
      "idx_verification_profile_type",
      "idx_verification_recommendations_change",
      "idx_external_tool_findings_subject",
      "idx_document_export_profile_family",
      "idx_document_export_run_family",
      "idx_document_export_run_snapshot",
      "idx_document_export_artifact_format",
      "idx_document_export_triggers_signal",
      "idx_screens_category",
      "idx_screen_trace_screen",
      "idx_spec_defs_owner",
      "idx_spec_defs_kind_layer_status",
      "idx_spec_defs_plan",
      "idx_spec_relations_from_kind",
      "idx_spec_relations_to_kind",
      "idx_schedule_plan_status",
      "idx_schedule_layer_subdoc_status",
      "idx_activation_profile_status",
      "idx_activation_version_status",
      "idx_activation_schedule_plan_profile",
      "idx_activation_schedule_scope_rag",
      "idx_document_catalog_layer_subdoc",
      "idx_document_catalog_doc_type",
      "idx_spec_rag_closure_rag_status",
      "idx_spec_rag_closure_spec",
      "idx_detector_candidates_source",
      "idx_detector_candidates_filing",
      "idx_detector_candidates_subject",
      "idx_agent_contracts_target",
    ]);
    expect(result.missingTables.map((item) => item.table)).not.toContain("spec_defs");
    expect(result.missingIndexes.map((item) => item.name)).not.toContain("idx_spec_defs_owner");
    expect(result.missingTables.map((item) => item.table)).not.toContain("refactor_candidates");
    expect(result.missingTables.map((item) => item.table)).not.toContain("screens");
    expect(result.missingTables.map((item) => item.table)).not.toContain("screen_trace");
    expect(result.missingIndexes.map((item) => item.name)).not.toContain(
      "idx_refactor_candidates_state",
    );
    expect(result.missingIndexes.map((item) => item.name)).not.toContain(
      "idx_refactor_candidates_plan",
    );
    expect(requirements.tables.map((item) => item.table)).toContain("refactor_candidates");
    expect(requirements.indexes.map((item) => item.name)).toContain(
      "idx_refactor_candidates_state",
    );
    expect(requirements.indexes.map((item) => item.name)).toContain("idx_refactor_candidates_plan");
    expect(result.missingTables).toEqual([]);
    expect(result.missingColumns).toEqual([]);
    expect(result.primaryKeyMismatches).toEqual([]);
    expect(dbProjectionCoverageMessages(result)[0]).toContain("db-projection-coverage - OK");
  });

  it("fails when a physical-data required table is absent from the schema registry", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.4 UT evidence history projection (A-122 / IMP-109)",
        "",
        "| table | primary key | required columns | purpose |",
        "|---|---|---|---|",
        "| `definitely_missing_projection_table` | `missing_id` | `plan_id`, `status` | sentinel |",
      ].join("\n"),
    );

    const result = analyzeDbProjectionCoverage(requirements);

    expect(result.ok).toBe(false);
    expect(result.missingTables.map((item) => item.table)).toEqual([
      "definitely_missing_projection_table",
    ]);
    expect(dbProjectionCoverageMessages(result).join("\n")).toContain("missing table");
  });

  it("does not treat nested canonical-ledger file registries as harness projection tables", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §2.7 SQLite projection DB の定義 (`harness.db`)",
        "",
        "#### §2.7.1 canonical ledgerファイル正本registry",
        "",
        "| ファイル | physical ownership | rebuild / migration / backup |",
        "|---|---|---|",
        "| `.ut-tdd/harness.db` | rebuildable projection only | projection owner |",
        "| `.ut-tdd/ledger/harness-ledger.db` | PLAN canonical ledger | PLAN owner |",
        "| `.ut-tdd/ledger/cutover-ledger.db` | cutover canonical ledger | cutover owner |",
        "",
        "### §2.8 後続節",
      ].join("\n"),
    );

    expect(requirements).toEqual([]);
  });

  it("does not leak a nested non-projection registry into the parent projection section", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §2.7 SQLite projection DB の定義 (`harness.db`)",
        "",
        "#### §2.7.2 provider ownership registry",
        "",
        "| registry | owner | purpose |",
        "|---|---|---|",
        "| `MANAGED-PROVIDER-REGISTRY-v1` | security | provider trust boundary |",
      ].join("\n"),
    );

    expect(requirements).toEqual([]);
  });

  it("keeps path-like identifiers declared by a projection table schema", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §2.7 SQLite projection DB の定義 (`harness.db`)",
        "",
        "| table | primary key | 主な列 | 入力 |",
        "|---|---|---|---|",
        "| `projection/path_like.db` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements.map((requirement) => requirement.table)).toEqual([
      "projection/path_like.db",
    ]);
  });

  it("does not broadly exclude an additional db identifier outside the 3DB ownership schema", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `fourth-ledger.db` | `record_id` | `digest` | detector sentinel |",
      ].join("\n"),
    );

    expect(requirements.map((requirement) => requirement.table)).toEqual(["fourth-ledger.db"]);
  });

  it("rejects a table when header and separator cell counts differ", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|",
        "| `mismatched_separator` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements).toEqual([]);
  });

  it("strips only balanced outer wrappers from projection headers", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| **table** | _主キー_ | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `wrapped_header_projection` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements.map((requirement) => requirement.table)).toEqual([
      "wrapped_header_projection",
    ]);
  });

  it("preserves internal header punctuation instead of normalizing it into a schema match", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| ta_ble | primary*key | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `foreign_schema` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements).toEqual([]);
  });

  it("ignores tables and index markers inside backtick and tilde fenced code", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "```markdown",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `fenced_backtick_table` | `projection_id` | `status` | fixture |",
        "必須 index:",
        "- `idx_fenced_backtick(status)`",
        "```",
        "",
        "~~~text",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `fenced_tilde_table` | `projection_id` | `status` | fixture |",
        "必要 index:",
        "- `idx_fenced_tilde(status)`",
        "~~~~",
      ].join("\n"),
    );

    expect(requirements).toEqual({ tables: [], indexes: [] });
  });

  it("does not activate an index marker outside a target projection scope", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      ["### §8.1 unrelated registry", "", "必須 index:", "", "- `idx_outside_target(status)`"].join(
        "\n",
      ),
    );

    expect(requirements.indexes).toEqual([]);
  });

  it("ends an active target at a deeper numbered non-descendant heading", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "#### §8.9 unrelated deeper section",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `deeper_non_descendant` | `projection_id` | `status` | fixture |",
        "必須 index:",
        "- `idx_deeper_non_descendant(status)`",
      ].join("\n"),
    );

    expect(requirements).toEqual({ tables: [], indexes: [] });
  });

  it("does not close a fence when the closing run has trailing content", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "```markdown",
        "``` not-a-close",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `still_fenced` | `projection_id` | `status` | fixture |",
        "```",
      ].join("\n"),
    );

    expect(requirements).toEqual([]);
  });

  it("resets pending table and index states at both fence boundaries", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "```",
        "```",
        "|---|---|---|---|",
        "| `cross_fence_table` | `projection_id` | `status` | fixture |",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `valid_projection` | `projection_id` | `status` | fixture |",
        "必須 index:",
        "```",
        "```",
        "- `idx_cross_fence(status)`",
      ].join("\n"),
    );

    expect(requirements.tables.map((requirement) => requirement.table)).toEqual([
      "valid_projection",
    ]);
    expect(requirements.indexes).toEqual([]);
  });

  it("does not treat a four-space indented backtick run as a fence", () => {
    const requirements = extractDbProjectionRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "    ```not-a-fence",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `after_indented_run` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements.map((requirement) => requirement.table)).toEqual(["after_indented_run"]);
  });

  it("keeps the real §9.3.1 projection table and its two indexes", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.3 index と invariant",
        "",
        "### 9.3.1 リファクタ候補 lifecycle 投影",
        "",
        "| table | 主キー | columns | 目的 |",
        "|---|---|---|---|",
        "| `refactor_candidates` | `candidate_key` | `state` | fixture |",
        "",
        "必要 index:",
        "",
        "- `idx_refactor_candidates_state(state, confidence, last_seen_at)`.",
        "- `idx_refactor_candidates_plan(linked_plan_id, state)`.",
      ].join("\n"),
    );

    expect(requirements.tables.map((requirement) => requirement.table)).toEqual([
      "refactor_candidates",
    ]);
    expect(requirements.indexes.map((requirement) => requirement.name)).toEqual([
      "idx_refactor_candidates_state",
      "idx_refactor_candidates_plan",
    ]);
  });

  it("does not collect index-like bullets from a nested non-projection registry", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.3 index と invariant",
        "",
        "必須 index:",
        "",
        "- `idx_valid_projection(plan_id, status)`",
        "",
        "#### §9.3.2 foreign registry",
        "",
        "- `foreign_registry(key)`",
      ].join("\n"),
    );

    expect(requirements.indexes.map((requirement) => requirement.name)).toEqual([
      "idx_valid_projection",
    ]);
  });

  it("collects index bullets only directly under the exact §9.3 index section", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §2.7 SQLite projection DB の定義 (`harness.db`)",
        "",
        "- `not_an_index_from_2_7(plan_id)`",
        "",
        "### §9.1 projection table 拡張",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `valid_9_1_projection` | `projection_id` | `status` | fixture |",
        "",
        "- `not_an_index_from_9_1(plan_id)`",
        "",
        "### §9.3 index と invariant",
        "",
        "必須 index:",
        "",
        "- `idx_valid_projection(plan_id, status)`",
      ].join("\n"),
    );

    expect(requirements.indexes.map((requirement) => requirement.name)).toEqual([
      "idx_valid_projection",
    ]);
  });

  it("collects projection tables from multi-digit §9 sections", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### 9.10 GitHub Forward基盤テーブル",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `github_projection_outbox` | `outbox_id` | `payload_digest` | fixture |",
        "",
        "### 9.11 Execution Episode目標テーブル",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `execution_github_projection_outbox` | `projection_id` | `episode_id` | fixture |",
        "",
        "### 9.20 Future projection table",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `future_projection` | `projection_id` | `status` | fixture |",
      ].join("\n"),
    );

    expect(requirements.tables.map((requirement) => requirement.table)).toEqual([
      "github_projection_outbox",
      "execution_github_projection_outbox",
      "future_projection",
    ]);
  });

  it("ends projection data at a backtick-labelled non-projection table header", () => {
    const requirements = extractDbProjectionCoverageRequirements(
      [
        "### §9.1 projection table 拡張",
        "",
        "| table | 主キー | 必須 columns | 目的 |",
        "|---|---|---|---|",
        "| `valid_projection` | `projection_id` | `status` | fixture |",
        "",
        "| `registry` | `owner` | `purpose` |",
        "|---|---|---|",
        "| `FOREIGN-REGISTRY-v1` | `security` | `trust boundary` |",
      ].join("\n"),
    );

    expect(requirements.tables.map((requirement) => requirement.table)).toEqual([
      "valid_projection",
    ]);
    expect(requirements.indexes).toEqual([]);
  });

  it("matches typed registry constraints against SQLite metadata", () => {
    const db = openHarnessDb(":memory:");
    try {
      db.exec(createTableSql(parent));
      db.exec(createTableSql(child));
      expect(analyzeDbConstraintCoverage(db, [parent, child])).toEqual({
        checked: 2,
        findings: [],
        ok: true,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    [
      "not-null",
      "parent_id TEXT, ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES coverage_parent(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(parent_id, ordinal), UNIQUE(owner_id, ordinal), FOREIGN KEY(parent_id) REFERENCES coverage_parent(id) ON DELETE RESTRICT, CHECK(status IN ('draft','confirmed'))",
    ],
    [
      "primary-key",
      "parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES coverage_parent(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(ordinal, parent_id), UNIQUE(owner_id, ordinal), FOREIGN KEY(parent_id) REFERENCES coverage_parent(id) ON DELETE RESTRICT, CHECK(status IN ('draft','confirmed'))",
    ],
    [
      "foreign-key",
      "parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(parent_id, ordinal), UNIQUE(owner_id, ordinal), CHECK(status IN ('draft','confirmed'))",
    ],
    [
      "unique",
      "parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES coverage_parent(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(parent_id, ordinal), FOREIGN KEY(parent_id) REFERENCES coverage_parent(id) ON DELETE RESTRICT, CHECK(status IN ('draft','confirmed'))",
    ],
    [
      "check",
      "parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES coverage_parent(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(parent_id, ordinal), UNIQUE(owner_id, ordinal), FOREIGN KEY(parent_id) REFERENCES coverage_parent(id) ON DELETE RESTRICT",
    ],
  ] as const)("fails closed when SQLite drops %s", (constraint, body) => {
    const db = openHarnessDb(":memory:");
    try {
      db.exec(createTableSql(parent));
      db.exec(`CREATE TABLE coverage_child (${body})`);
      const result = analyzeDbConstraintCoverage(db, [child]);
      expect(result.ok).toBe(false);
      expect(result.findings.map((finding) => finding.constraint)).toContain(constraint);
    } finally {
      db.close();
    }
  });
});
