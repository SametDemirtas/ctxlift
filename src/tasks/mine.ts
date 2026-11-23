import type { Task } from "../types.ts";
import type { PullRequestSource } from "./github.ts";
import { buildPrompt } from "./prompt.ts";
import { DEFAULT_LIMITS, type SelectLimits, selectPullRequest } from "./select.ts";

export interface MineOptions {
  repo: string;
  since: string;
  max: number;
  limits?: SelectLimits;
  log?: (msg: string) => void;
}

export function mineTasks(source: PullRequestSource, o: MineOptions): Task[] {
  const tasks: Task[] = [];
  const short = o.repo.split("/")[1];
  for (const pr of source.mergedPulls(o.repo, o.since)) {
    const sel = selectPullRequest(pr, o.limits ?? DEFAULT_LIMITS);
    if (!sel.ok) {
      o.log?.(`skip #${pr.number}: ${sel.reason}`);
      continue;
    }
    const { prompt, removedLines } = buildPrompt(pr.title, pr.body);
    tasks.push({
      id: `${short}-${pr.number}`,
      repo: o.repo,
      pr: pr.number,
      title: pr.title,
      prompt,
      mergeSha: pr.mergeSha,
      mergedAt: pr.mergedAt,
      commits: pr.commits,
      allFiles: [...new Set(pr.files.flatMap((f) => (f.previousFilename ? [f.filename, f.previousFilename] : [f.filename])))],
      srcFiles: sel.srcFiles,
      testFiles: sel.testFiles,
      removedTestFiles: sel.removedTestFiles,
      srcLines: sel.srcLines,
      promptRemovedLines: removedLines,
    });
    if (tasks.length >= o.max) break;
  }
  return tasks;
}
