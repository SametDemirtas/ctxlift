import { rng } from "./random.ts";
import { latestByKey } from "./results/records.ts";
import type { RunRecord } from "./types.ts";

export interface ArmStats {
  arm: string;
  runs: number;
  resolved: number;
  // per task, so tasks with more runs don't weigh more
  taskWeightedRate: number;
  contaminated: number;
  timeouts: number;
  agentLimits: number;
  agentErrors: number;
  // timeouts report none, so cost is understated when there are many
  meanCostUsd: number | null;
  unknownCost: number;
  budgetCapped: number;
  suspect: number;
  infra: number;
  // many more in one arm means that arm was resampled more often
  infraRetried: number;
  costPerResolvedUsd: number | null;
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

export interface Comparison {
  warnings: string[];
  armsInResults: string[];
  scope: { repo: string; agent: string; agentVersions: string[]; model: string; modelsResolved: string[]; sandboxes: string[] };
  baseline: string;
  treatment: string;
  pairedTasks: number;
  identicalArmTasks: number;
  excludedInfra: number;
  arms: [ArmStats, ArmStats];
  successDiff: Interval;
  pValue: number;
  tasksBetter: number;
  tasksWorse: number;
  // 80% power at alpha 0.05, normal approximation
  minDetectableDiff: number | null;
  sensitivityExcludingFlagged: number | null;
  sensitivityInfraAsFailure: number | null;
  costRatio: Interval | null;
  costRatioRange: { low: number; high: number } | null;
  tasksWithoutCost: number;
  tasksOnlyInfra: number;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function percentile(sorted: number[], p: number): number {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// over tasks, so repeated runs of one task aren't treated as independent
export function bootstrap<T>(items: T[], stat: (sample: T[]) => number, resamples: number, seed: number): Interval {
  const estimate = stat(items);
  const next = rng(seed);
  const values: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(next() * items.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) values.push(v);
  }
  values.sort((a, b) => a - b);
  if (values.length === 0) return { estimate, low: Number.NaN, high: Number.NaN };
  return { estimate, low: percentile(values, 0.025), high: percentile(values, 0.975) };
}

// exact up to 2^16 flips, Monte Carlo beyond
export function signFlipPValue(diffs: number[], seed = 1, samples = 100_000): number {
  const nonzero = diffs.filter((d) => d !== 0);
  if (nonzero.length === 0) return 1;
  const observed = Math.abs(nonzero.reduce((a, b) => a + b, 0));
  const eps = 1e-12;
  if (nonzero.length <= 16) {
    let extreme = 0;
    const total = 2 ** nonzero.length;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < nonzero.length; i++) s += mask & (1 << i) ? -nonzero[i] : nonzero[i];
      if (Math.abs(s) >= observed - eps) extreme++;
    }
    return extreme / total;
  }
  const next = rng(seed);
  let extreme = 0;
  for (let k = 0; k < samples; k++) {
    let s = 0;
    for (const d of nonzero) s += next() < 0.5 ? -d : d;
    if (Math.abs(s) >= observed - eps) extreme++;
  }
  return (extreme + 1) / (samples + 1);
}

function knownCosts(rs: RunRecord[]): number[] {
  return rs.map((r) => r.usage.costUsd).filter((c): c is number => c !== null);
}

const meanCost = (rs: RunRecord[]): number | null => {
  const cs = knownCosts(rs);
  return cs.length > 0 ? mean(cs) : null;
};

const resolvedWithCost = (runs: RunRecord[]): number => runs.filter((r) => r.usage.costUsd !== null && success(r) === 1).length;

// contaminated runs count as failures; infra failures are left out and counted separately
const success = (r: RunRecord): number => (r.resolved && !r.contaminated ? 1 : 0);

function armStats(arm: string, runs: RunRecord[], byTask: Map<string, RunRecord[]>, infra: number, infraRetried: number): ArmStats {
  const costs = knownCosts(runs);
  const resolved = runs.filter((r) => success(r) === 1).length;
  return {
    arm,
    runs: runs.length,
    resolved,
    taskWeightedRate: mean([...byTask.values()].map((rs) => mean(rs.map(success)))),
    contaminated: runs.filter((r) => r.contaminated).length,
    timeouts: runs.filter((r) => r.kind === "timeout").length,
    agentLimits: runs.filter((r) => r.kind === "agent_limit").length,
    agentErrors: runs.filter((r) => r.kind === "agent_error").length,
    meanCostUsd: costs.length > 0 ? mean(costs) : null,
    unknownCost: runs.length - costs.length,
    budgetCapped: runs.filter((r) => r.limit === "budget").length,
    suspect: runs.filter((r) => r.suspect.length > 0).length,
    infra,
    infraRetried,
    // runs without cost data are left out of both sides, so resolved timeouts don't make an arm look cheaper
    costPerResolvedUsd: resolvedWithCost(runs) > 0 ? costs.reduce((a, b) => a + b, 0) / resolvedWithCost(runs) : null,
  };
}

function filledMean(paired: [string, { a: RunRecord[]; b: RunRecord[] }][], side: "a" | "b", fill: (r: RunRecord) => number): number {
  return mean(paired.map(([, e]) => mean(e[side].map((r) => r.usage.costUsd ?? fill(r)))));
}

// lowest ratio fills the treatment at $0 and the baseline at the budget, the highest the other way round
function costRange(paired: [string, { a: RunRecord[]; b: RunRecord[] }][]): { low: number; high: number } | null {
  const runs = paired.flatMap(([, e]) => [...e.a, ...e.b]);
  if (!runs.some((r) => r.usage.costUsd === null)) return null;
  const zero = () => 0;
  const budget = (r: RunRecord) => r.settings.budgetUsd;
  const aHigh = filledMean(paired, "a", budget);
  const aLow = filledMean(paired, "a", zero);
  const low = aHigh > 0 ? filledMean(paired, "b", zero) / aHigh : Number.NaN;
  const high = aLow > 0 ? filledMean(paired, "b", budget) / aLow : Number.POSITIVE_INFINITY;
  return Number.isNaN(low) ? null : { low, high };
}

const contextSignature = (r: RunRecord): string => JSON.stringify(r.contextFiles.map((c) => [c.path, c.sha256]));

function taskDiffs(paired: [string, { a: RunRecord[]; b: RunRecord[] }][], keep: (r: RunRecord) => boolean): number[] {
  const out: number[] = [];
  for (const [, e] of paired) {
    const a = e.a.filter(keep);
    const b = e.b.filter(keep);
    if (a.length > 0 && b.length > 0) out.push(mean(b.map(success)) - mean(a.map(success)));
  }
  return out;
}

function scopeOf(records: RunRecord[]): Comparison["scope"] {
  const one = (field: "repo" | "agent" | "model") => {
    const values = [...new Set(records.map((r) => r[field]))];
    if (values.length > 1) throw new Error(`results mix several ${field}s (${values.join(", ")}); filter them first`);
    return values[0];
  };
  return {
    repo: one("repo"),
    agent: one("agent"),
    model: one("model"),
    agentVersions: [...new Set(records.map((r) => r.agentVersion))].sort(),
    modelsResolved: [...new Set(records.map((r) => r.modelResolved).filter((m): m is string => Boolean(m)))].sort(),
    sandboxes: [...new Set(records.map((r) => r.settings.sandbox))].sort(),
  };
}

export function compareArms(records: RunRecord[], baseline: string, treatment: string, resamples = 5000, seed = 1): Comparison {
  const inArms = records.filter((r) => r.arm === baseline || r.arm === treatment);
  const latest = latestByKey(inArms);
  const retriedInfra = (arm: string) => inArms.filter((r) => r.arm === arm && r.kind === "infra").length - latest.filter((r) => r.arm === arm && r.kind === "infra").length;
  const infra = latest.filter((r) => r.kind === "infra");
  const usable = latest.filter((r) => r.kind !== "infra");

  const byTask = new Map<string, { a: RunRecord[]; b: RunRecord[] }>();
  for (const r of usable) {
    const e = byTask.get(r.task) ?? { a: [], b: [] };
    (r.arm === baseline ? e.a : e.b).push(r);
    byTask.set(r.task, e);
  }
  const both = [...byTask.entries()].filter(([, e]) => e.a.length > 0 && e.b.length > 0);
  const sigOf = (rs: RunRecord[]) => contextSignature(rs.find((r) => r.kind !== "infra") ?? rs[0]);
  const differs = ([, e]: [string, { a: RunRecord[]; b: RunRecord[] }]) => sigOf(e.a) !== sigOf(e.b);
  const paired = both.filter(differs);
  if (paired.length === 0) {
    throw new Error(`no task has usable runs in both "${baseline}" and "${treatment}" with different context files`);
  }
  const pairedRuns = paired.flatMap(([, e]) => [...e.a, ...e.b]);
  const scope = scopeOf(pairedRuns);

  const diffs = taskDiffs(paired, () => true);
  const unflagged = taskDiffs(paired, (r) => !r.contaminated && r.suspect.length === 0);
  // every task with any run in both arms, counting infra failures as failed attempts, so a task whose runs in one arm all failed for infrastructure reasons still shows up here
  const withInfra = new Map<string, { a: RunRecord[]; b: RunRecord[] }>();
  for (const r of latest) {
    const e = withInfra.get(r.task) ?? { a: [], b: [] };
    (r.arm === baseline ? e.a : e.b).push(r);
    withInfra.set(r.task, e);
  }
  const comparable = [...withInfra.entries()].filter(([, e]) => e.a.length > 0 && e.b.length > 0 && differs(["", e]));
  const comparableIds = new Set(comparable.map(([id]) => id));
  const infraAsFailure = taskDiffs(comparable, () => true);
  // one task set for the cost ratio and its range: tasks with cost data in both arms (and a baseline cost above zero)
  const costTasks = paired.filter(([, e]) => (meanCost(e.a) ?? 0) > 0 && meanCost(e.b) !== null);
  const costPairs = costTasks.map(([, e]) => ({ a: meanCost(e.a) as number, b: meanCost(e.b) as number }));
  const ratio = (s: { a: number; b: number }[]) => mean(s.map((p) => p.b)) / mean(s.map((p) => p.a));
  const armTasks = (side: "a" | "b") => new Map(paired.map(([id, e]) => [id, e[side]]));
  const infraIn = (arm: string) => infra.filter((r) => r.arm === arm && comparableIds.has(r.task)).length;
  const spread = sd(diffs);
  const warnings: string[] = [];
  const settingSets = new Set(pairedRuns.map((r) => JSON.stringify(r.settings)));
  if (settingSets.size > 1) warnings.push(`runs used ${settingSets.size} different settings (budget, timeout, sandbox or head commit)`);
  const drifting = paired.filter(([, e]) => new Set(e.a.map(contextSignature)).size > 1 || new Set(e.b.map(contextSignature)).size > 1);
  if (drifting.length > 0) warnings.push(`${drifting.length} tasks saw different context files across repetitions of the same arm`);
  const changedPaths = new Set<string>();
  for (const [, e] of paired) {
    const files = (rs: RunRecord[]) => new Set((rs.find((r) => r.kind !== "infra") ?? rs[0]).contextFiles.map((c) => `${c.path} ${c.sha256}`));
    const [fa, fb] = [files(e.a), files(e.b)];
    for (const f of [...fa, ...fb]) if (!(fa.has(f) && fb.has(f))) changedPaths.add(f.split(" ")[0]);
  }
  if (changedPaths.size > 0 && [...changedPaths].every((p) => /(^|\/)AGENTS\.md$/i.test(p))) {
    warnings.push("the arms differ only in AGENTS.md; check that this Claude Code version loads AGENTS.md before reading a null result");
  }
  const infraTotal = (arm: string) => retriedInfra(arm) + infraIn(arm);
  const [ra, rb] = [infraTotal(baseline), infraTotal(treatment)];
  // when every failure was run again nothing is excluded and the counts only show how often each arm was retried
  if (ra !== rb && Math.max(ra, rb) >= 2 && infra.some((r) => comparableIds.has(r.task))) {
    warnings.push(`infrastructure failures differ between arms (${baseline}: ${ra}, ${treatment}: ${rb}, retried or excluded); see the line that counts them as failures`);
  }

  return {
    warnings,
    armsInResults: [...new Set(records.map((r) => r.arm))].sort(),
    scope,
    baseline,
    treatment,
    pairedTasks: paired.length,
    identicalArmTasks: both.length - paired.length,
    excludedInfra: infra.filter((r) => comparableIds.has(r.task)).length,
    tasksOnlyInfra: comparable.length - paired.length,
    arms: [
      armStats(baseline, pairedRuns.filter((r) => r.arm === baseline), armTasks("a"), infraIn(baseline), retriedInfra(baseline)),
      armStats(treatment, pairedRuns.filter((r) => r.arm === treatment), armTasks("b"), infraIn(treatment), retriedInfra(treatment)),
    ],
    successDiff: bootstrap(diffs, mean, resamples, seed),
    pValue: signFlipPValue(diffs, seed),
    tasksBetter: diffs.filter((d) => d > 0).length,
    tasksWorse: diffs.filter((d) => d < 0).length,
    minDetectableDiff: diffs.length >= 2 && spread > 0 ? (2.8 * spread) / Math.sqrt(diffs.length) : null,
    sensitivityExcludingFlagged: unflagged.length > 0 ? mean(unflagged) : null,
    sensitivityInfraAsFailure: infra.some((r) => comparableIds.has(r.task)) ? mean(infraAsFailure) : null,
    costRatio: costPairs.length > 0 ? bootstrap(costPairs, ratio, resamples, seed + 1) : null,
    costRatioRange: costRange(costTasks),
    tasksWithoutCost: paired.length - costTasks.length,
  };
}
