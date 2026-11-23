export interface CommitGraph {
  revParse(rev: string): string | null;
  changedFiles(from: string, to: string): string[];
}

// pr.base.sha is the base branch tip at the PR's last update, possibly many commits older; a candidate counts only if the diff from it to the merge commit touches exactly the PR's files
// rebase merges try `commits` back first, because the first parent of a rebased PR can also touch every PR file
export function resolveBase(g: CommitGraph, mergeSha: string, commits: number, prFiles: string[]): string | null {
  const want = new Set(prFiles);
  const candidates = commits > 1 ? [`${mergeSha}~${commits}`, `${mergeSha}^1`] : [`${mergeSha}^1`];
  for (const rev of candidates) {
    const sha = g.revParse(rev);
    if (!sha) continue;
    const got = new Set(g.changedFiles(sha, mergeSha));
    if (got.size === want.size && [...want].every((f) => got.has(f))) return sha;
  }
  return null;
}
