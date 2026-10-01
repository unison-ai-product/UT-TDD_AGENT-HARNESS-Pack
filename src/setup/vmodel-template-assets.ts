export interface VModelTemplateAsset {
  readonly path: string;
  readonly content: string;
}

declare const __UT_TDD_BUNDLED__: boolean;

const bundled = typeof __UT_TDD_BUNDLED__ !== "undefined" && __UT_TDD_BUNDLED__ === true;

// The authoritative Node builder resolves these text-loader inputs into the
// sealed consumer bundle. Source execution intentionally uses the filesystem.
const EMBEDDED_VMODEL_TEMPLATES: readonly VModelTemplateAsset[] = bundled
  ? [
      { path: "README.md", content: require("ut-tdd-vmodel-templates/README.md") as string },
      {
        path: "L0-charter.md",
        content: require("ut-tdd-vmodel-templates/L0-charter.md") as string,
      },
      {
        path: "L1-requirements.md",
        content: require("ut-tdd-vmodel-templates/L1-requirements.md") as string,
      },
      {
        path: "L2-screen-list.md",
        content: require("ut-tdd-vmodel-templates/L2-screen-list.md") as string,
      },
      {
        path: "L3-functional-requirements.md",
        content: require("ut-tdd-vmodel-templates/L3-functional-requirements.md") as string,
      },
      {
        path: "L4-data.md",
        content: require("ut-tdd-vmodel-templates/L4-data.md") as string,
      },
      {
        path: "L4-architecture.md",
        content: require("ut-tdd-vmodel-templates/L4-architecture.md") as string,
      },
      {
        path: "L4-external-if.md",
        content: require("ut-tdd-vmodel-templates/L4-external-if.md") as string,
      },
      {
        path: "L4-function.md",
        content: require("ut-tdd-vmodel-templates/L4-function.md") as string,
      },
      {
        path: "L4-ui-standard.md",
        content: require("ut-tdd-vmodel-templates/L4-ui-standard.md") as string,
      },
      {
        path: "L4-security.md",
        content: require("ut-tdd-vmodel-templates/L4-security.md") as string,
      },
      {
        path: "L5-physical-data.md",
        content: require("ut-tdd-vmodel-templates/L5-physical-data.md") as string,
      },
      {
        path: "L5-module-decomposition.md",
        content: require("ut-tdd-vmodel-templates/L5-module-decomposition.md") as string,
      },
      {
        path: "L6-function-spec.md",
        content: require("ut-tdd-vmodel-templates/L6-function-spec.md") as string,
      },
      {
        path: "L7-unit-test-design.md",
        content: require("ut-tdd-vmodel-templates/L7-unit-test-design.md") as string,
      },
      {
        path: "L8-integration-test-design.md",
        content: require("ut-tdd-vmodel-templates/L8-integration-test-design.md") as string,
      },
      {
        path: "L9-system-test-design.md",
        content: require("ut-tdd-vmodel-templates/L9-system-test-design.md") as string,
      },
      {
        path: "L10-ux-validation.md",
        content: require("ut-tdd-vmodel-templates/L10-ux-validation.md") as string,
      },
      {
        path: "L11-trace-uat.md",
        content: require("ut-tdd-vmodel-templates/L11-trace-uat.md") as string,
      },
      {
        path: "L12-acceptance-test-design.md",
        content: require("ut-tdd-vmodel-templates/L12-acceptance-test-design.md") as string,
      },
      {
        path: "L13-production-observation.md",
        content: require("ut-tdd-vmodel-templates/L13-production-observation.md") as string,
      },
      {
        path: "L14-operational-test-design.md",
        content: require("ut-tdd-vmodel-templates/L14-operational-test-design.md") as string,
      },
      {
        path: "optional/012-test-plan.md",
        content: require("ut-tdd-vmodel-templates/optional/012-test-plan.md") as string,
      },
      {
        path: "optional/013-migration-plan.md",
        content: require("ut-tdd-vmodel-templates/optional/013-migration-plan.md") as string,
      },
      {
        path: "optional/014-issue-risk-decision-log.md",
        content:
          require("ut-tdd-vmodel-templates/optional/014-issue-risk-decision-log.md") as string,
      },
      {
        path: "optional/015-development-standards.md",
        content: require("ut-tdd-vmodel-templates/optional/015-development-standards.md") as string,
      },
      {
        path: "optional/016-batch-design.md",
        content: require("ut-tdd-vmodel-templates/optional/016-batch-design.md") as string,
      },
      {
        path: "optional/017-design-index-definitions.md",
        content:
          require("ut-tdd-vmodel-templates/optional/017-design-index-definitions.md") as string,
      },
      {
        path: "optional/019-workflow-definition.md",
        content: require("ut-tdd-vmodel-templates/optional/019-workflow-definition.md") as string,
      },
      {
        path: "optional/020-metrics-kpi-design.md",
        content: require("ut-tdd-vmodel-templates/optional/020-metrics-kpi-design.md") as string,
      },
      {
        path: "optional/025-network-design.md",
        content: require("ut-tdd-vmodel-templates/optional/025-network-design.md") as string,
      },
      {
        path: "optional/026-server-infrastructure-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/026-server-infrastructure-design.md") as string,
      },
      {
        path: "optional/030-glossary-data-dictionary.md",
        content:
          require("ut-tdd-vmodel-templates/optional/030-glossary-data-dictionary.md") as string,
      },
      {
        path: "optional/033-traceability-id-conventions.md",
        content:
          require("ut-tdd-vmodel-templates/optional/033-traceability-id-conventions.md") as string,
      },
      {
        path: "optional/035-reliability-dr-bcp-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/035-reliability-dr-bcp-design.md") as string,
      },
      {
        path: "optional/036-privacy-design.md",
        content: require("ut-tdd-vmodel-templates/optional/036-privacy-design.md") as string,
      },
      {
        path: "optional/038-ci-cd-pipeline-design.md",
        content: require("ut-tdd-vmodel-templates/optional/038-ci-cd-pipeline-design.md") as string,
      },
      {
        path: "optional/044-deliverable-index-map.md",
        content: require("ut-tdd-vmodel-templates/optional/044-deliverable-index-map.md") as string,
      },
      {
        path: "optional/045-directory-structure-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/045-directory-structure-design.md") as string,
      },
      {
        path: "optional/046-seo-public-page-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/046-seo-public-page-design.md") as string,
      },
      {
        path: "optional/047-support-escalation-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/047-support-escalation-design.md") as string,
      },
      {
        path: "optional/048-user-documentation-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/048-user-documentation-design.md") as string,
      },
      {
        path: "optional/049-ai-output-verification-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/049-ai-output-verification-design.md") as string,
      },
      {
        path: "optional/050-stop-resume-execution-log-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/050-stop-resume-execution-log-design.md") as string,
      },
      {
        path: "optional/052-documentation-policy-tailoring.md",
        content:
          require("ut-tdd-vmodel-templates/optional/052-documentation-policy-tailoring.md") as string,
      },
      {
        path: "optional/053-poc-verification-design.md",
        content:
          require("ut-tdd-vmodel-templates/optional/053-poc-verification-design.md") as string,
      },
      {
        path: "optional/096-design-principles-seven-pillars.md",
        content:
          require("ut-tdd-vmodel-templates/optional/096-design-principles-seven-pillars.md") as string,
      },
      {
        path: "optional/108-refactoring-design.md",
        content: require("ut-tdd-vmodel-templates/optional/108-refactoring-design.md") as string,
      },
      {
        path: "optional/109-qa-quality-checklist.md",
        content: require("ut-tdd-vmodel-templates/optional/109-qa-quality-checklist.md") as string,
      },
    ]
  : [];

export function embeddedVModelTemplateAssets(): readonly VModelTemplateAsset[] {
  return EMBEDDED_VMODEL_TEMPLATES;
}

export function embeddedVModelTemplatePortIndex(): string | undefined {
  return bundled ? (require("ut-tdd-vmodel-templates/README.md") as string) : undefined;
}

export function embeddedVModelDocumentCatalog(): string | undefined {
  return bundled ? (require("ut-tdd-vmodel-document-catalog") as string) : undefined;
}
