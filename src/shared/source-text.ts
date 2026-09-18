/** OS path separatorをrepository canonical `/`へ正規化するneutral helper。 */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
