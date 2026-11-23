import type { Outcome, RunnerSpec, Task, ValidTask } from "../types.ts";
import { yieldToEvents } from "../events.ts";
import { resolveBase } from "./base.ts";
import { classifyTests, isUsableTask } from "./classify.ts";
import { type EvalContext, type HiddenTestSpec, isResetBeforeGrading, runHiddenTests } from "./evaluate.ts";

export interface ValidateOptions {
  afterRuns: number;
  beforeRuns?: number;
  log?: (msg: string) => void;
  onProgress?: (valid: ValidTask[], dropped: Record<string, string>) => void;
}

// `retry` marks environment failures, which are not recorded so a later run tries again
export type ValidationResult = { ok: true; task: ValidTask } | { ok: false; reason: string; retry?: boolean };

type Tests = { ok: true; tests: Map<string, Outcome> } | { ok: false; reason: string; retry?: boolean };

function testsOf(ctx: EvalContext, spec: HiddenTestSpec, overlay: string[], label: string): Tests {
  const r = runHiddenTests(ctx, spec, (ws) => ws.overlayFrom(spec.mergeSha, overlay));
  // setup runs before any change is applied, and an infra failure says nothing about the task: try again next time
  if (r.kind === "infra") return { ok: false, reason: `infra on ${label}: ${r.reason}`, retry: true };
  if (r.collectionErrors.length > 0) {
    return { ok: false, reason: `test file fails to load on ${label}: ${r.collectionErrors.map((c) => c.file).join(", ")}` };
  }
  return { ok: true, tests: r.tests };
}

// gold must pass every fail-to-pass test and break no pass-to-pass test in every one of `afterRuns` runs
// a test module that fails to load on the base commit drops the task: grading it would hinge on guessing names the prompt never states
export function validateTask(ctx: EvalContext, t: Task, o: ValidateOptions): ValidationResult {
  ctx.source.ensureCommit(t.mergeSha);
  const baseSha = resolveBase(ctx.source, t.mergeSha, t.commits, t.allFiles);
  if (!baseSha) return { ok: false, reason: "could not find the commit the PR was applied to" };
  const targets = t.testFiles.filter((f) => ctx.runner.isTarget(f));
  if (targets.length === 0) return { ok: false, reason: `no ${ctx.runner.spec.name} test modules among the PR's test files` };

  const spec: HiddenTestSpec = { baseSha, mergeSha: t.mergeSha, testFiles: t.testFiles, removedTestFiles: t.removedTestFiles, testTargets: targets };
  const gold = t.allFiles.filter((f) => !isResetBeforeGrading(f));
  const isLink = (rev: string) => {
    const blobs = ctx.source.listBlobs(rev);
    return (f: string) => blobs.get(f)?.mode === "120000";
  };
  if (gold.some(isLink(t.mergeSha)) || gold.some(isLink(baseSha))) {
    return { ok: false, reason: "the change involves a symlink, which grading never carries over from the agent" };
  }
  const before: Map<string, Outcome>[] = [];
  for (let i = 0; i < (o.beforeRuns ?? 2); i++) {
    const r = testsOf(ctx, spec, [], "base");
    if (!r.ok) return r;
    before.push(r.tests);
  }
  const after: Map<string, Outcome>[] = [];
  for (let i = 0; i < o.afterRuns; i++) {
    const r = testsOf(ctx, spec, gold, "gold");
    if (!r.ok) return r;
    after.push(r.tests);
  }
  const c = classifyTests(before, after);
  const summary = `f2p=${c.failToPass.length} p2p=${c.passToPass.length} flaky=${c.flaky.length} brokenAfter=${c.brokenAfter.length}`;
  if (!isUsableTask(c)) return { ok: false, reason: summary };
  o.log?.(`${t.id}: ${summary}`);
  return {
    ok: true,
    task: { ...t, baseSha, runner: ctx.runner.spec, testTargets: targets, failToPass: c.failToPass, passToPass: c.passToPass, flaky: c.flaky },
  };
}

// tasks validated or dropped under other commands would otherwise stay as they were
export function resumeMismatch(previous: { valid: unknown[]; dropped: Record<string, string> }, earlier: RunnerSpec | undefined, current: RunnerSpec): string | null {
  if (previous.valid.length === 0 && Object.keys(previous.dropped).length === 0) return null;
  if (earlier === undefined) return "with test or setup commands that weren't recorded";
  return JSON.stringify(earlier) === JSON.stringify(current) ? null : "with other test or setup commands";
}

export async function validateTasks(
  ctx: EvalContext,
  tasks: Task[],
  o: ValidateOptions & { shouldStop?: () => boolean },
  previous: { valid: ValidTask[]; dropped: Record<string, string> } = { valid: [], dropped: {} },
): Promise<{ valid: ValidTask[]; dropped: Record<string, string> }> {
  const valid = [...previous.valid];
  const dropped = { ...previous.dropped };
  const done = new Set([...valid.map((t) => t.id), ...Object.keys(dropped)]);
  if (done.size > 0) o.log?.(`${done.size} tasks already decided, skipping them`);
  for (const t of tasks) {
    await yieldToEvents();
    if (o.shouldStop?.()) {
      o.log?.("stopping: interrupted");
      break;
    }
    if (done.has(t.id)) continue;
    let r: ValidationResult;
    try {
      r = validateTask(ctx, t, o);
    } catch (e) {
      r = { ok: false, reason: `error: ${(e as Error).message.split("\n")[0]}`, retry: true };
    }
    await yieldToEvents();
    if (o.shouldStop?.()) {
      o.log?.(`stopping: interrupted during ${t.id}; it will be validated again next time`);
      break;
    }
    const label = r.ok ? "KEEP" : r.retry ? "retry later" : "drop";
    o.log?.(`${label} ${t.id}${r.ok ? "" : `  ${r.reason}`}  ${t.title.slice(0, 60)}`);
    if (r.ok) valid.push(r.task);
    else if (!r.retry) dropped[t.id] = r.reason;
    o.onProgress?.(valid, dropped);
  }
  return { valid, dropped };
}
