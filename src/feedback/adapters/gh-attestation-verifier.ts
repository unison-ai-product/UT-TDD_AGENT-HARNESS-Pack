/**
 * `gh attestation verify` を唯一の GitHub provenance verifier として使う adapter
 * (PLAN-L7-465 §D3c freeze「発行・検証境界」4)。
 *
 * 不在 / 署名不正 / issuer 不一致 / 取得不能を成功へ丸めず、typed reason へ落とす。
 * raw stdout / stderr は返さない (token や absolute path の巻き込みを構造的に断つ)。
 *
 * 判定は行わない。ここは certificate の URI 形を receipt の field 形へ正規化するだけで、
 * receipt との照合そのものは domain (`admitReviewCustody`) が持つ。
 */
import { spawnSync } from "node:child_process";
import type {
  GitHubAttestationFacts,
  GitHubAttestationQuery,
  GitHubAttestationVerification,
  GitHubAttestationVerifierPort,
} from "../ports/github-attestation-verifier.ts";

export interface GhCommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

export interface GhAttestationVerifierOptions {
  /** `gh attestation verify` 相当の実行子。テストではここを差し替える。 */
  readonly runCommand?: (args: readonly string[]) => GhCommandResult;
  readonly ghBinary?: string;
}

const GITHUB_URL_PREFIX = "https://github.com/";
const RUN_INVOCATION_PATTERN = /\/actions\/runs\/([0-9]{1,20})\/attempts\/([0-9]{1,6})$/;

function defaultRunner(binary: string): (args: readonly string[]) => GhCommandResult {
  return (args) => {
    const result = spawnSync(binary, [...args], { encoding: "utf8", windowsHide: true });
    if (result.error) {
      // 実行不能は「検証できなかった」であって「検証に失敗した」ではない。
      return { status: null, stdout: "" };
    }
    return { status: result.status, stdout: result.stdout ?? "" };
  };
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripGitHubPrefix(value: string | null): string | null {
  if (value === null) return null;
  return value.startsWith(GITHUB_URL_PREFIX) ? value.slice(GITHUB_URL_PREFIX.length) : value;
}

function pick(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * statement の subject digest 集合を取り出す。
 *
 * 実測 (2026-08-07、`gh attestation verify gh_2.97.0_windows_arm64.zip --repo cli/cli
 * --format json`): `verificationResult.statement.subject` は `{name, digest:{sha256}}` の配列で、
 * 1 つの attestation が複数 artifact を被覆しうる。したがって「entry があること」ではなく
 * 「対象 digest を被覆していること」を見る必要がある。
 */
function subjectDigests(verification: unknown): string[] {
  const subject = pick(pick(verification, "statement"), "subject");
  if (!Array.isArray(subject)) return [];
  const digests: string[] = [];
  for (const entry of subject as readonly unknown[]) {
    const value = readText(pick(pick(entry, "digest"), "sha256"));
    if (value !== null) digests.push(value);
  }
  return digests;
}

/**
 * Sigstore certificate extension の URI 形を receipt の field 形へ正規化する。
 *
 * field 名と URI 形は実出力で確認済み (同上の実測):
 * `sourceRepositoryURI=https://github.com/cli/cli`、
 * `buildSignerURI=https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk`、
 * `buildSignerDigest=<40 lowerhex>`、`issuer=https://token.actions.githubusercontent.com`、
 * `runInvocationURI=https://github.com/cli/cli/actions/runs/<id>/attempts/<n>`。
 */
export function normalizeAttestationCertificate(input: {
  certificate: unknown;
  subjectDigests: readonly string[];
}): GitHubAttestationFacts | null {
  const { certificate } = input;
  const repository = stripGitHubPrefix(readText(pick(certificate, "sourceRepositoryURI")));
  const workflowRef = stripGitHubPrefix(readText(pick(certificate, "buildSignerURI")));
  const workflowSha = readText(pick(certificate, "buildSignerDigest"));
  const issuer = readText(pick(certificate, "issuer"));
  const invocation = readText(pick(certificate, "runInvocationURI"));
  if (
    repository === null ||
    workflowRef === null ||
    workflowSha === null ||
    issuer === null ||
    invocation === null
  ) {
    return null;
  }
  const runMatch = RUN_INVOCATION_PATTERN.exec(invocation);
  if (runMatch === null) return null;
  return {
    repository,
    workflowRef,
    workflowSha,
    runId: runMatch[1],
    runAttempt: Number(runMatch[2]),
    issuer,
    subjectDigests: [...input.subjectDigests],
  };
}

/** 実出力の外殻 (`[{attestation, verificationResult}]`) を剥がして entry 列を返す。 */
function verificationResults(parsed: unknown): unknown[] {
  const entries = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  return entries.map((entry) => pick(entry, "verificationResult") ?? entry);
}

/** `gh attestation verify` を呼ぶ port 実装。 */
export function createGhAttestationVerifier(
  options: GhAttestationVerifierOptions = {},
): GitHubAttestationVerifierPort {
  const run = options.runCommand ?? defaultRunner(options.ghBinary ?? "gh");
  return {
    verify(query: GitHubAttestationQuery): Promise<GitHubAttestationVerification> {
      const result = run([
        "attestation",
        "verify",
        // subject は positional の file path でしか渡せない (`--digest` は存在しない)。
        query.artifactPath,
        `--repo=${query.repository}`,
        `--signer-workflow=${query.expectedWorkflowRef.split("@")[0]}`,
        `--cert-oidc-issuer=${query.expectedIssuer}`,
        "--format=json",
      ]);
      if (result.status === null) {
        return Promise.resolve({ ok: false, reason: "audit_unavailable" });
      }
      if (result.status !== 0) {
        // gh は不在と署名不正を同じ exit code で返す。出力が無い場合だけ不在側へ倒し、
        // 出力がある場合は検証失敗として扱う (不明を成功へ丸めない)。
        const reason = result.stdout.trim().length === 0 ? "missing" : "signature_unverified";
        return Promise.resolve({ ok: false, reason });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout) as unknown;
      } catch (error) {
        // parse 不能は検証結果を読めていないので audit_unavailable (成功へ丸めない)。
        const kind = error instanceof Error ? "json_syntax" : "json_unknown";
        void kind;
        return Promise.resolve({ ok: false, reason: "audit_unavailable" });
      }
      let normalized = 0;
      for (const verification of verificationResults(parsed)) {
        const digests = subjectDigests(verification);
        const facts = normalizeAttestationCertificate({
          certificate: pick(pick(verification, "signature"), "certificate"),
          subjectDigests: digests,
        });
        if (facts === null) continue;
        normalized += 1;
        if (digests.includes(query.artifactDigest)) return Promise.resolve({ ok: true, facts });
      }
      // certificate が 1 件も読めないのは検証結果を解釈できていない状態 (成功へ丸めない)。
      // 読めたが対象 digest を被覆する statement が無い場合は、この artifact の attestation は
      // 存在しない。
      return Promise.resolve({
        ok: false,
        reason: normalized === 0 ? "audit_unavailable" : "missing",
      });
    },
  };
}
