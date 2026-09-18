/**
 * UT-TDD PLAN frontmatter schema (requirements_v1.2 §1.1 / §1.9 / §1.10 A).
 * §1 enum を単一正本 (./index) から合成し、§1.1 排他制約 / §1.1.parent_design /
 * charter(L0) を superRefine で fail-close 検証する。
 * 最終同期: requirements v1.2 §1.1-§1.1.排他制約 / §1.2.2 / §3.3 / §3.4
 *
 * 注: kind×drive matrix (§1.6) / 必須 role (§1.8) / dependencies.requires の
 * status=completed 検証 (§1.10 C-E) は cross-record / matrix lookup を伴うため
 * plan lint エンジン側 (将来 PLAN) で実装する。本 schema は単一 PLAN 内
 * (intra-record) の §1.1 制約に限定する。
 */
import { z } from "zod";
import {
  artifactTypeSchema,
  decisionOutcomeSchema,
  driveSchema,
  forwardRoutingSchema,
  isValidSubDocForLayer,
  kindSchema,
  layerSchema,
  promotionStrategySchema,
  reverseTypeSchema,
  roleSchema,
  scrumTypeSchema,
  statusSchema,
  subDocSchema,
  workflowPhaseSchema,
} from "./index.ts";
import { PLAN_ID_PATTERN } from "./plan-id.ts";

/**
 * §1.10 A plan_id 形式 (phase-aware + 駆動モデル legible): `PLAN-<token>-<NN>-slug`。
 * token = ① Forward 工程 = `L0`〜`L14` (該当工程、token↔layer 一致) / ② 横断駆動モデル = `DISCOVERY`(kind=poc) / `REVERSE`(kind=reverse) / `RECOVERY`(kind=recovery) (token↔kind 一致、layer=cross) / ③ `M` (master plan)。
 * 旧 `X`(cross) は駆動モデルを潰し ID から読めなかったため、駆動モデル名トークンへ置換 (option 1、PO 2026-06-01)。
 * NN = token 内 2 桁以上連番 (L7 等で 99 到達後は 100+ も許容、`\d{2,}`)、slug = kebab。**旧 flat `PLAN-001..004` は archived 別名前空間** (衝突しない)。
 * 狙い: ID 単体で 工程/駆動モデル + phase を判別 → state(DB) が phase↔PLAN を拾える。
 */
export const planIdSchema = z.string().regex(PLAN_ID_PATTERN, {
  message:
    "plan_id は PLAN-<token>-<NN>-slug 形式 (token = L0〜L14 / DISCOVERY / REVERSE / RECOVERY / M、§1.10 A)",
});

/** §1.10 A 駆動モデルトークン ↔ kind 対応 (横断駆動プランの ID legibility 正本) */
export const DRIVE_TOKEN_TO_KIND: Record<string, string> = {
  DISCOVERY: "poc",
  REVERSE: "reverse",
  RECOVERY: "recovery",
};

/** §1.8 agent_slots エントリ */
export const agentSlotSchema = z.object({
  role: roleSchema,
  slot_label: z.string().min(1),
});

/** §1.1 generates エントリ (双方向 trace の起点) */
export const generatesEntrySchema = z.object({
  artifact_path: z.string().min(1),
  artifact_type: artifactTypeSchema,
});

/** §1.9 dependencies */
export const dependenciesSchema = z.object({
  parent: z.string().nullable().default(null),
  requires: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
});

/** 正規authoring経路が発行する自己検証可能なAdmission証明。既存PLANへの遡及強制はdiff fence側で行う。 */
const admissionReceiptSchema = z
  .object({
    schema_version: z.literal("v2"),
    receipt_id: z.string().min(1),
    command_id: z.string().min(1),
    admitted_at: z.string().min(1),
    source_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
    decision_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
    receipt_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
    binding: z
      .object({
        path: z.string().regex(/^docs\/plans\/PLAN-[A-Za-z0-9-]+\.md$/),
        plan_id: planIdSchema,
        asset_id: z.string().regex(/^plan:[a-z0-9][a-z0-9:-]{2,127}$/),
        revision: z.number().int().positive(),
        content_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
      })
      .strict(),
    route: z.object({ signal: z.string().min(1), mode: z.string().min(1) }).strict(),
    issue: z
      .object({
        provider: z.literal("github"),
        issue_id: z.number().int().positive(),
        episode_id: z.string().min(1),
        projection_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
      })
      .strict()
      .optional(),
    origin: z
      .object({
        plan_id: z.string().min(1),
        revision: z.number().int().positive(),
        digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
      })
      .strict()
      .optional(),
    transition: z
      .object({
        direction: z.enum(["implementation_to_design", "design_to_implementation"]),
        implementation_disposition: z.enum(["preserved", "discarded", "none"]),
        implementation_target: z
          .object({
            target_plan_id: z.string().min(1),
            target_revision: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    reentry: z
      .object({
        target_plan_id: z.string().min(1),
        target_revision: z.number().int().positive(),
        phase: z.literal("forward_merge"),
      })
      .strict()
      .optional(),
    escape_reason: z.string().min(1).optional(),
    supersedes: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** §1.1 全 variant 共通フィールド (variant 固有制約は superRefine で fail-close) */
const frontmatterBaseSchema = z.object({
  plan_id: planIdSchema,
  title: z.string().min(1),
  kind: kindSchema,
  drive: driveSchema,
  status: statusSchema.default("draft"),
  layer: layerSchema.optional(),
  sub_doc: subDocSchema.optional(),
  master_hub: z.boolean().optional(),
  workflow_phase: workflowPhaseSchema.optional(),
  parent_design: z.string().optional(),
  decision_outcome: decisionOutcomeSchema.nullable().optional(),
  confirmed_reverse_type: reverseTypeSchema.optional(),
  scrum_type: scrumTypeSchema.nullable().optional(),
  forward_routing: forwardRoutingSchema.nullable().optional(),
  promotion_strategy: promotionStrategySchema.nullable().optional(),
  agent_slots: z.array(agentSlotSchema).min(1, "agent_slots は 1 件以上 (§1.8)"),
  generates: z.array(generatesEntrySchema).default([]),
  dependencies: dependenciesSchema,
  /** §6.8.2 Issue 起点スパイン: 解決対象 GitHub Issue 番号 (任意、Phase 0-B で recommended)。
   *  feature/hotfix branch の close 漏れ機械検知 + PR `Closes #NN` 連携に使う。 */
  github_issue_id: z.number().int().positive().nullable().optional(),
  backprop_decision: z.enum(["required", "not_required"]).optional(),
  backprop_decision_reason: z.string().optional(),
  /** PLAN-DISCOVERY-09 version-up: 将来版へ保全 (deferred-but-committed-future) する PLAN のマーカー。
   *  status=draft でのみ有効 (landed には付与不可、Codex Critical: landing-time 除外禁止)。label は
   *  version-up ledger に照合する (forward-convergence.ts VERSION_UP_ALLOWED_TARGETS)。 */
  version_target: z.string().optional(),
  route_signal: z.string().optional(),
  route_mode: z.string().optional(),
  admission_receipt: admissionReceiptSchema.optional(),
  /** 右腕検証 PLAN の gate 結合。kind=verify は layer=L8-L14 と G8-G14 を 1:1 で宣言する。 */
  verification_gate: z.string().optional(),
  /** migration import trace reference (optional migration ledger path) */
  v2_import: z.string().optional(),
  /** review 前置エビデンス (requirements §7.8.7 / .claude/CLAUDE.md MUST、IMP-071)。
   *  design/impl/add-* PLAN が confirmed (gate/freeze 到達) に至る前に通した review を構造的に記録する。
   *  review_kind = cross_agent (hybrid) | intra_runtime_subagent (claude/codex 単体) | human (standalone/escalation)。
   *  機械強制 = doctor checkReviewEvidence (fail-close → hard)。freeze 後の増分追補も entry を append する
   *  (concept §2.1.2.1 の review tier と整合、review-skip の silent 化を機械で塞ぐ)。 */
  review_evidence: z
    .array(
      z.object({
        reviewer: z.string().min(1),
        review_kind: z.enum(["cross_agent", "intra_runtime_subagent", "human"]),
        reviewed_at: z.string().min(1),
        verdict: z.string().min(1),
        scope: z.string().optional(),
        /** test→review 順序強制 (IMP-077): 定量検証 (vitest/doctor/lint) が green になった時刻。
         *  `tests_green_at ≤ reviewed_at` (定量テスト→定性レビュー) が全駆動モデル普遍の不変条件
         *  (未検証成果物をレビューしない)。当初 optional、実 repo back-fill 後 presence hard。 */
        tests_green_at: z.string().optional(),
        green_commands: z
          .array(
            z.object({
              kind: z.enum([
                "unit_test",
                "integration_test",
                "typecheck",
                "lint",
                "doctor",
                "vmodel_lint",
                "smoke",
              ]),
              command: z.string().min(1),
              // node = Node 一本化 (PLAN-L7-462) 後の正規 runner。bun は既存証跡の後方互換
              // のため残置 (新規記録では使わない)。
              runner: z.enum(["bun", "node", "powershell", "bash", "ci"]),
              scope: z.enum(["full", "targeted", "changed-files", "gate"]),
              exit_code: z.literal(0),
              completed_at: z.string().optional(),
              evidence_path: z.string().min(1),
              output_digest: z.string().regex(/^sha256:[a-f0-9]{16,64}$/i),
              anchor_commit: z.string().min(1).optional(),
            }),
          )
          .optional(),
        /** cross-review semantic 強制 (IMP-076): レビュー対象成果物を産出した model /
         *  reviewer の model。review_kind=cross_agent では両者 present かつ相異が必須
         *  (same_model_approval: forbidden、concept §2.1.2.1)。単体 runtime は相異 model を
         *  供給できないため cross_agent を僭称できない。intra_runtime_subagent/human は任意。 */
        worker_model: z.string().optional(),
        reviewer_model: z.string().optional(),
        lane: z.enum(["claim-blind", "spec-blind"]).optional(),
        plan_revision: z.string().min(1).optional(),
        subject_head: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/i)
          .optional(),
        attack_trials: z.number().int().min(0).optional(),
        citations: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
  /** PLAN-L7-89: 本 PLAN が誤記/誤った前提を訂正・無効化する先行 PLAN の plan_id 群 (errata back-link)。
   *  confirmed PLAN の主張が後で誤りと判明したとき、後継が `supersedes: [先行 plan_id]` を宣言し、
   *  先行 PLAN は本 PLAN の plan_id を訂正注記として持つ (双方向)。doctor plan-supersession が
   *  「宣言された supersede 先が実在 + 相互 back-reference 済」を fail-close 強制する (誤記の silent 放置を塞ぐ)。 */
  supersedes: z.array(z.string()).optional(),
});

/** layer=cross を取る横断駆動 kind (Discovery=poc / Reverse=reverse / Recovery=recovery) */
const CROSS_KINDS = new Set<string>(["poc", "reverse", "recovery"]);
/** workflow_phase (S/R) を取る kind (Scrum=poc S0-S4 / Reverse R0-R4)。recovery は phase を持たない */
const WORKFLOW_KINDS = new Set<string>(["poc", "reverse"]);

const custom = z.ZodIssueCode.custom;

const ALLOWED_LAYER_BY_KIND: Record<string, readonly string[]> = {
  design: ["L1", "L2", "L3", "L4", "L5", "L6"],
  impl: ["L7"],
  refactor: ["L7"],
  retrofit: ["L7"],
  troubleshoot: ["L7"],
  research: ["L1", "L2", "L3", "L4"],
  verify: ["L8", "L9", "L10", "L11", "L12", "L13", "L14"],
};

const VERIFICATION_GATE_BY_LAYER: Record<string, string> = {
  L8: "G8",
  L9: "G9",
  L10: "G10",
  L11: "G11",
  L12: "G12",
  L13: "G13",
  L14: "G14",
};

/**
 * §1.1 排他制約 + §1.1.parent_design + charter(L0) + §1.10 E を fail-close 検証する frontmatter schema。
 */
export const frontmatterSchema = frontmatterBaseSchema.superRefine((fm, ctx) => {
  const isCrossKind = CROSS_KINDS.has(fm.kind);
  const isWorkflowKind = WORKFLOW_KINDS.has(fm.kind);
  const receipt = fm.admission_receipt;
  if (receipt) {
    if (receipt.binding.plan_id !== fm.plan_id) {
      ctx.addIssue({
        code: custom,
        path: ["admission_receipt", "binding", "plan_id"],
        message: "receipt binding plan_idはfrontmatterと一致必須",
      });
    }
    if (fm.route_signal !== receipt.route.signal || fm.route_mode !== receipt.route.mode) {
      ctx.addIssue({
        code: custom,
        path: ["admission_receipt", "route"],
        message: "receipt route はtop-level route宣言と一致必須",
      });
    }
    const declaredSupersedes = fm.supersedes ?? [];
    const receiptedSupersedes = receipt.supersedes ?? [];
    if (
      declaredSupersedes.length !== receiptedSupersedes.length ||
      declaredSupersedes.some((planId, index) => planId !== receiptedSupersedes[index])
    ) {
      ctx.addIssue({
        code: custom,
        path: ["supersedes"],
        message: "top-level supersedesはreceiptと完全一致必須",
      });
    }
    if (receipt.issue && fm.github_issue_id !== receipt.issue.issue_id) {
      ctx.addIssue({
        code: custom,
        path: ["github_issue_id"],
        message: "github_issue_id はreceipt Issueと一致必須",
      });
    }
    const isForward = receipt.route.mode === "forward";
    if (
      isForward &&
      (receipt.issue ||
        receipt.origin ||
        receipt.reentry ||
        receipt.escape_reason ||
        receipt.transition)
    ) {
      ctx.addIssue({
        code: custom,
        path: ["admission_receipt"],
        message: "通常Forward receiptにescape専用項目は許可しない",
      });
    }
    if (
      !isForward &&
      (!receipt.issue || !receipt.origin || !receipt.reentry || !receipt.escape_reason)
    ) {
      ctx.addIssue({
        code: custom,
        path: ["admission_receipt"],
        message: "Forward外receiptはIssue/origin/reentry/escape_reason必須",
      });
    }
    if (receipt.route.mode === "reverse") {
      const transition = receipt.transition;
      if (
        transition?.direction !== "implementation_to_design" ||
        transition.implementation_disposition !== "preserved"
      ) {
        ctx.addIssue({
          code: custom,
          path: ["admission_receipt", "transition"],
          message: "reverseは実装→設計かつpreserved必須",
        });
      }
    }
    if (receipt.route.mode === "redesign") {
      const transition = receipt.transition;
      if (
        transition?.direction !== "design_to_implementation" ||
        !["discarded", "none"].includes(transition.implementation_disposition) ||
        !transition.implementation_target ||
        receipt.supersedes?.length !== 1
      ) {
        ctx.addIssue({
          code: custom,
          path: ["admission_receipt"],
          message: "redesignは設計→実装、discarded/none、target、supersedes一件必須",
        });
      }
    }
  }

  if (isCrossKind) {
    // §1.1: 横断駆動 (poc/reverse/recovery) → layer は cross のみ
    if (fm.layer !== "cross") {
      ctx.addIssue({
        code: custom,
        path: ["layer"],
        message: `kind=${fm.kind} は layer=cross のみ許可 (§1.1)`,
      });
    }
    // §1.1: poc/reverse は workflow_phase 必須 / recovery は phase を持たない (禁止)
    if (isWorkflowKind && !fm.workflow_phase) {
      ctx.addIssue({
        code: custom,
        path: ["workflow_phase"],
        message: `kind=${fm.kind} は workflow_phase 必須 (§1.1)`,
      });
    }
    if (!isWorkflowKind && fm.workflow_phase) {
      ctx.addIssue({
        code: custom,
        path: ["workflow_phase"],
        message: `kind=${fm.kind} に workflow_phase は禁止 (§1.1)`,
      });
    }
  } else {
    // §1.1: 横断駆動以外 → 実 layer 必須 / workflow_phase 禁止
    if (!fm.layer || fm.layer === "cross") {
      ctx.addIssue({
        code: custom,
        path: ["layer"],
        message: `kind=${fm.kind} は実 layer 必須 (cross 不可、§1.1)`,
      });
    }
    if (fm.workflow_phase) {
      ctx.addIssue({
        code: custom,
        path: ["workflow_phase"],
        message: `kind=${fm.kind} に workflow_phase は禁止 (§1.1)`,
      });
    }
  }

  if (
    fm.kind === "design" &&
    !fm.master_hub &&
    fm.layer &&
    ["L1", "L2", "L3", "L4", "L5", "L6"].includes(fm.layer)
  ) {
    if (!fm.sub_doc) {
      ctx.addIssue({
        code: custom,
        path: ["sub_doc"],
        message: "kind=design + layer=L1-L6 は sub_doc 必須 (§1.10.G.1)",
      });
    } else if (!isValidSubDocForLayer(fm.layer, fm.sub_doc)) {
      ctx.addIssue({
        code: custom,
        path: ["sub_doc"],
        message: "sub_doc は layer 別 VALID_SUB_DOCS のみ (§1.10.G.1)",
      });
    }
  }

  // §1.10 A: plan_id の駆動トークン ↔ kind 一致 (横断駆動プランの ID legibility、fail-close)
  const driveTok = fm.plan_id.match(/^PLAN-(DISCOVERY|REVERSE|RECOVERY)-/)?.[1];
  if (driveTok && DRIVE_TOKEN_TO_KIND[driveTok] !== fm.kind) {
    ctx.addIssue({
      code: custom,
      path: ["plan_id"],
      message: `plan_id token=${driveTok} は kind=${DRIVE_TOKEN_TO_KIND[driveTok]} のみ (現 kind=${fm.kind}、§1.10 A)`,
    });
  }
  const layerTok = fm.plan_id.match(/^PLAN-(L(?:[0-9]|1[0-4]))-/)?.[1];
  if (layerTok && fm.layer && fm.layer !== layerTok) {
    ctx.addIssue({
      code: custom,
      path: ["layer"],
      message: `plan_id token=${layerTok} は layer=${layerTok} のみ (現 layer=${fm.layer}、§1.10 A)`,
    });
  }
  if (fm.kind === "verify") {
    const expectedGate = fm.layer ? VERIFICATION_GATE_BY_LAYER[fm.layer] : undefined;
    if (expectedGate && !fm.verification_gate) {
      ctx.addIssue({
        code: custom,
        path: ["verification_gate"],
        message: `kind=verify + layer=${fm.layer} は verification_gate=${expectedGate} 必須 (§1.10 A / right-arm gate binding)`,
      });
    } else if (expectedGate && fm.verification_gate !== expectedGate) {
      ctx.addIssue({
        code: custom,
        path: ["verification_gate"],
        message: `kind=verify + layer=${fm.layer} は verification_gate=${expectedGate} のみ (現 ${fm.verification_gate})`,
      });
    }
  } else if (fm.verification_gate) {
    ctx.addIssue({
      code: custom,
      path: ["verification_gate"],
      message: "verification_gate は kind=verify のみ (§1.10 A / right-arm gate binding)",
    });
  }

  // §1.1: kind=poc → workflow_phase ∈ {S0..S4}
  if (fm.kind === "poc" && fm.workflow_phase && !fm.workflow_phase.startsWith("S")) {
    ctx.addIssue({
      code: custom,
      path: ["workflow_phase"],
      message: "kind=poc は workflow_phase ∈ {S0..S4} (§1.1)",
    });
  }
  // §1.1: kind=reverse → workflow_phase ∈ {R0..R4}
  if (fm.kind === "reverse" && fm.workflow_phase && !fm.workflow_phase.startsWith("R")) {
    ctx.addIssue({
      code: custom,
      path: ["workflow_phase"],
      message: "kind=reverse は workflow_phase ∈ {R0..R4} (§1.1)",
    });
  }

  // §3.5: kind=poc は scrum_type を S3 以降必須 (S0-S2 は null 可、6 種 = §3.2)
  if (
    fm.kind === "poc" &&
    (fm.workflow_phase === "S3" || fm.workflow_phase === "S4") &&
    !fm.scrum_type
  ) {
    ctx.addIssue({
      code: custom,
      path: ["scrum_type"],
      message: "kind=poc は workflow_phase S3 以降で scrum_type 必須 (6 種、§3.5 / §3.2)",
    });
  }

  // §1.1: kind=poc + S4 → decision_outcome 必須
  if (fm.kind === "poc" && fm.workflow_phase === "S4" && !fm.decision_outcome) {
    ctx.addIssue({
      code: custom,
      path: ["decision_outcome"],
      message: "kind=poc + S4 は decision_outcome 必須 (§1.1 / §1.2.2)",
    });
  }

  // §3.3: kind=reverse → confirmed_reverse_type 必須
  if (fm.kind === "reverse" && !fm.confirmed_reverse_type) {
    ctx.addIssue({
      code: custom,
      path: ["confirmed_reverse_type"],
      message: "kind=reverse は confirmed_reverse_type 必須 (§3.3)",
    });
  }
  // §3.4: kind=reverse + R4 → forward_routing / promotion_strategy 必須
  if (fm.kind === "reverse" && fm.workflow_phase === "R4") {
    if (!fm.forward_routing) {
      ctx.addIssue({
        code: custom,
        path: ["forward_routing"],
        message: "kind=reverse + R4 は forward_routing 必須 (§3.4)",
      });
    }
    if (!fm.promotion_strategy) {
      ctx.addIssue({
        code: custom,
        path: ["promotion_strategy"],
        message: "kind=reverse + R4 は promotion_strategy 必須 (§3.4)",
      });
    }
  }

  // §1.1.parent_design: kind=impl (L7) は parent_design 必須
  if (fm.kind === "impl" && !fm.master_hub && !fm.parent_design) {
    ctx.addIssue({
      code: custom,
      path: ["parent_design"],
      message: "kind=impl (L7) は parent_design 必須 (§1.1.parent_design)",
    });
  }

  // charter(L0): kind=charter は layer=L0 のみ (root, parent_design 不要)
  if (fm.kind === "charter" && fm.layer !== "L0") {
    ctx.addIssue({
      code: custom,
      path: ["layer"],
      message: "kind=charter は layer=L0 のみ (§1.3 / §2.1.1)",
    });
  }

  // PLAN-DISCOVERY-09: version_target (version-up parked) は status=draft のみ有効 (landed 除外禁止)
  if (fm.version_target && fm.status !== "draft") {
    ctx.addIssue({
      code: custom,
      path: ["version_target"],
      message:
        "version_target は status=draft のみ有効 (landed=confirmed/completed には付与不可、PLAN-DISCOVERY-09)",
    });
  }

  // §1.10 E: kind=add-* は dependencies.parent 必須 (null 不可)
  if ((fm.kind === "add-design" || fm.kind === "add-impl") && !fm.dependencies.parent) {
    ctx.addIssue({
      code: custom,
      path: ["dependencies", "parent"],
      message: "kind=add-* は dependencies.parent 必須 (§1.10 E)",
    });
  }

  // §1.1: kind=add-design は L3-L6 / kind=add-impl は L7 (§1.3 主な layer の fail-close 化、DISCOVERY 起票監査)
  if (fm.kind === "add-design" && fm.layer && !["L3", "L4", "L5", "L6"].includes(fm.layer)) {
    ctx.addIssue({
      code: custom,
      path: ["layer"],
      message: "kind=add-design は layer ∈ {L3,L4,L5,L6} (§1.3 設計追補、§1.1)",
    });
  }
  if (fm.kind === "add-impl" && fm.layer !== "L7") {
    ctx.addIssue({
      code: custom,
      path: ["layer"],
      message: "kind=add-impl は layer=L7 (§1.3 実装追補、§1.1)",
    });
  }

  const allowedLayers = ALLOWED_LAYER_BY_KIND[fm.kind];
  if (allowedLayers && !fm.master_hub && fm.layer && !allowedLayers.includes(fm.layer)) {
    ctx.addIssue({
      code: custom,
      path: ["layer"],
      message: `kind=${fm.kind} は layer ∈ {${allowedLayers.join(",")}} (§1.10 kind×layer authoring guard)`,
    });
  }
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;
