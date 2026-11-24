export interface IssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)$/;

export function parseIssueUrl(text: string): IssueRef | null {
  const match = ISSUE_URL_PATTERN.exec(text);
  if (!match || match[0] !== text) return null;
  const [, owner, repo, issueNumber] = match;
  if (owner === undefined || repo === undefined || issueNumber === undefined) return null;

  return {
    owner,
    repo,
    number: Number(issueNumber),
  };
}
