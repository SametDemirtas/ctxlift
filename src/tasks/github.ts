import { execOk } from "../exec.ts";
import type { PrFile, PullRequest } from "../types.ts";

export interface PullRequestSource {
  defaultBranch(repo: string): string;
  // newest first
  mergedPulls(repo: string, since: string): Iterable<PullRequest>;
}

const MAX_LIST_PAGES = 30;

function api<T>(path: string): T {
  return JSON.parse(execOk("gh", ["api", path])) as T;
}

function apiLines<T>(path: string, jq: string): T[] {
  return execOk("gh", ["api", "--paginate", path, "--jq", jq])
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export class GhCliSource implements PullRequestSource {
  defaultBranch(repo: string): string {
    return api<{ default_branch: string }>(`repos/${repo}`).default_branch;
  }

  *mergedPulls(repo: string, since: string): Iterable<PullRequest> {
    const branch = this.defaultBranch(repo);
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const list = api<any[]>(
        `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      if (list.length === 0) return;
      for (const pr of list) {
        if (!pr.merged_at || pr.merged_at < since) continue;
        const detail = api<any>(`repos/${repo}/pulls/${pr.number}`);
        const files = apiLines<PrFile>(
          `repos/${repo}/pulls/${pr.number}/files?per_page=100`,
          ".[] | {filename, status, additions, deletions, previousFilename: .previous_filename}",
        ).map((f) => (f.previousFilename ? f : { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
        yield {
          number: pr.number,
          title: pr.title ?? "",
          body: pr.body ?? "",
          mergedAt: pr.merged_at,
          mergeSha: detail.merge_commit_sha,
          commits: detail.commits,
          changedFiles: detail.changed_files,
          files,
        };
      }
      // updated_at >= merged_at, so once a whole page was last updated before `since`, nothing older can qualify
      if (list.every((pr) => pr.updated_at < since)) return;
    }
  }
}
