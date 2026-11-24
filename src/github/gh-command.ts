/** GitHub CLI に終了を要求するまでの待機時間。 */
export const GH_COMMAND_TIMEOUT_MS = 30_000;

/** 呼び出し元の環境を維持し、GitHub CLI の対話プロンプトを抑止する。 */
export function ghCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GH_PROMPT_DISABLED: "1" };
}
