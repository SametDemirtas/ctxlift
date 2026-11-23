import { type Agent, type AgentRunResult, EMPTY_USAGE } from "../agents/types.ts";
import type { ArmContext } from "../arms.ts";
import { yieldToEvents } from "../events.ts";
import type { RunRecord, ValidTask } from "../types.ts";
import type { WorkspaceHandle } from "../workspace.ts";
import type { Grade } from "./grade.ts";
import type { PlanItem } from "./plan.ts";

export interface RunOptions {
  shouldStop?: () => boolean;
  // so a broken setup doesn't use up quota
  maxConsecutiveInfra: number;
  log?: (msg: string) => void;
}

export interface RunStore {
  completedKeys(): Set<string>;
  append(r: RunRecord): void;
}

export interface RunDeps {
  agent: Agent;
  store: RunStore;
  armContext: ArmContext;
  createWorkspace(task: ValidTask, prepare: (dir: string) => void): WorkspaceHandle;
  prepareWorkspace(ws: WorkspaceHandle, task: ValidTask): string | null;
  grade(ws: WorkspaceHandle, task: ValidTask): Grade;
  testsRunOnBase(task: ValidTask): boolean;
}

export class RunAborted extends Error {}

export const INTERRUPTED = "stopping: interrupted (finished runs are saved; run the same command to continue)";

function baseRecord(item: PlanItem, agent: Agent): RunRecord {
  return {
    key: item.key,
    repo: item.task.repo,
    task: item.task.id,
    arm: item.arm.id,
    rep: item.rep,
    agent: agent.name,
    agentVersion: agent.version(),
    model: item.model,
    kind: "infra",
    subtype: null,
    resolved: false,
    f2pPassed: 0,
    f2pTotal: item.task.failToPass.length,
    p2pBroken: 0,
    contaminated: false,
    audit: [],
    suspect: [],
    gradingNote: null,
    limit: null,
    modelResolved: null,
    settings: item.settings,
    contextFiles: [],
    usage: EMPTY_USAGE,
    error: null,
    at: new Date().toISOString(),
  };
}

// a runner failure is retried once because environment rebuilds can fail transiently
// if the tests still run on untouched code the agent broke them; otherwise the environment is broken and the run is infrastructure
async function gradeRun(deps: RunDeps, ws: WorkspaceHandle, task: ValidTask, rec: RunRecord, shouldStop: () => boolean): Promise<void> {
  const attemptGrade = (): Grade => {
    try {
      return deps.grade(ws, task);
    } catch (e) {
      return { kind: "infra", reason: `grading error: ${(e as Error).message}` };
    }
  };
  let g = attemptGrade();
  await yieldToEvents();
  if (shouldStop()) return;
  if (g.kind === "infra") g = attemptGrade();
  await yieldToEvents();
  if (shouldStop()) return;
  if (g.kind === "graded") {
    Object.assign(rec, { resolved: g.resolved, f2pPassed: g.f2pPassed, p2pBroken: g.p2pBroken, gradingNote: g.note });
  } else if (!g.environment && deps.testsRunOnBase(task)) {
    Object.assign(rec, { resolved: false, gradingNote: g.reason.slice(0, 400) });
  } else {
    Object.assign(rec, { kind: "infra", error: `grading: ${g.reason}`.slice(0, 400) });
  }
}

async function attempt(deps: RunDeps, item: PlanItem, rec: RunRecord, shouldStop: () => boolean): Promise<AgentRunResult | null> {
  let ws: WorkspaceHandle | null = null;
  let res: AgentRunResult | null = null;
  try {
    ws = deps.createWorkspace(item.task, (dir) => item.arm.prepare(dir, deps.armContext));
    const setupError = deps.prepareWorkspace(ws, item.task);
    // recorded after setup, so anything setup added is included in what the agent was shown
    rec.contextFiles = ws.contextFiles();
    if (setupError) {
      Object.assign(rec, { kind: "infra", error: setupError.slice(0, 400) });
      return null;
    }
    // a stop request (e.g. SIGTERM to this process only) can arrive during setup: don't start a paid agent run
    await yieldToEvents();
    if (shouldStop()) return null;
    res = deps.agent.run({ cwd: ws.dir, prompt: item.task.prompt, model: item.model, budgetUsd: item.settings.budgetUsd, timeoutMs: item.settings.timeoutMs });
    Object.assign(rec, {
      kind: res.kind,
      subtype: res.subtype,
      usage: res.usage,
      audit: res.audit,
      suspect: res.suspect,
      contaminated: res.audit.length > 0,
      limit: res.limit,
      modelResolved: res.modelResolved,
      error: res.message,
    });
    await yieldToEvents();
    // interrupted during the agent run: the result is discarded anyway, so don't spend minutes grading it
    if (res.kind !== "infra" && !shouldStop()) await gradeRun(deps, ws, item.task, rec, shouldStop);
  } catch (e) {
    Object.assign(rec, { kind: "infra", error: (e as Error).message.slice(0, 400) });
  } finally {
    ws?.dispose();
  }
  return res;
}

// a fatal agent error is recorded, then stops the whole run
async function runOne(deps: RunDeps, item: PlanItem, shouldStop: () => boolean): Promise<{ rec: RunRecord; fatal: string | null }> {
  const rec = baseRecord(item, deps.agent);
  const res = await attempt(deps, item, rec, shouldStop);
  return { rec, fatal: res?.fatal ? (res.message ?? "fatal agent error") : null };
}

export interface WorkSource {
  next(): Promise<PlanItem | null>;
  done?(item: PlanItem): void;
}

export function listSource(items: PlanItem[]): WorkSource {
  let i = 0;
  return { next: async () => items[i++] ?? null };
}

// finished runs are skipped, so re-running after a crash is safe
export async function executePlan(deps: RunDeps, plan: PlanItem[], o: RunOptions): Promise<RunRecord[]> {
  const done = deps.store.completedKeys();
  const todo = plan.filter((p) => !done.has(p.key));
  o.log?.(`${plan.length} runs planned, ${plan.length - todo.length} already done, ${todo.length} to go`);
  return executeItems(deps, listSource(todo), o);
}

export async function executeItems(deps: RunDeps, source: WorkSource, o: RunOptions): Promise<RunRecord[]> {
  const shouldStop = o.shouldStop ?? (() => false);
  deps.agent.preflight();
  const out: RunRecord[] = [];
  let infraStreak = 0;
  for (;;) {
    await yieldToEvents();
    if (shouldStop()) throw new RunAborted(INTERRUPTED);
    const item = await source.next();
    if (!item) break;
    if (shouldStop()) throw new RunAborted(INTERRUPTED);
    const { rec: r, fatal } = await runOne(deps, item, shouldStop);
    // an interrupt reaches the running child too (pytest even reports it as an ordinary exit), so this run's result can't be trusted: drop it, and it is redone on resume
    await yieldToEvents();
    if (shouldStop()) throw new RunAborted(INTERRUPTED);
    deps.store.append(r);
    source.done?.(item);
    if (fatal) throw new RunAborted(`stopping: ${fatal}`);
    out.push(r);
    const cost = r.usage.costUsd === null ? "?" : r.usage.costUsd.toFixed(3);
    const verdict = r.kind === "infra" ? "INFRA" : r.resolved && !r.contaminated ? "PASS " : "fail ";
    const flags = `${r.contaminated ? "  CONTAMINATED" : ""}${r.suspect.length > 0 ? `  suspect(${r.suspect.length})` : ""}`;
    o.log?.(`${verdict} ${item.key}  $${cost}  ${r.kind}${flags}${r.error ? `  ${r.error.slice(0, 100)}` : ""}`);
    infraStreak = r.kind === "infra" ? infraStreak + 1 : 0;
    if (infraStreak >= o.maxConsecutiveInfra) throw new RunAborted(`stopping after ${infraStreak} infrastructure failures in a row`);
  }
  return out;
}
