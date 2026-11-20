export interface PathFs {
  isFile(path: string): boolean;
  canExecute(path: string): boolean;
}

export interface FindOnPathInput {
  command: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fs?: PathFs;
}

// 契約形の stub (L7 provider-command-resolution §5、design-protection-diff-gate §10.3 手順 1')。
// 常に「見つからない」を返し、何も実行しない。実装は #1694 の Green PR で入れる。
export function findOnPath(_input: FindOnPathInput): string | null {
  return null;
}
