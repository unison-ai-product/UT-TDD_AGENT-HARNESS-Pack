// 公開 repo のため名前をリテラルで書かない。
export const LEGACY_SOURCE_REPO = ["ai-dev-kit", "vscode"].join("-");

export const PERSONAL_ABSOLUTE_PATH_PATTERN = String.raw`(?:^|[\s"'([{=])(?:[A-Za-z]:\\Users\\[^\\/"'\s]+|/(?:Users|home)/[^/"'\s]+)`;

export const PERSONAL_ABSOLUTE_PATH_RE = new RegExp(PERSONAL_ABSOLUTE_PATH_PATTERN, "i");

export function hasPersonalAbsolutePath(text: string): boolean {
  return PERSONAL_ABSOLUTE_PATH_RE.test(text);
}
