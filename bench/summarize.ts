import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatComparison } from "../src/report.ts";
import { parseRecords } from "../src/results/records.ts";
import { type Comparison, type Interval, compareArms } from "../src/stats.ts";
import type { RunRecord } from "../src/types.ts";

const BASELINE = "none";
const TREATMENT = "repo";

export interface RepoResult {
  repo: string;
  records: RunRecord[];
  comparison: Comparison;
  merged?: [string, string];
}

export function parseStrict(text: string, name: string): RunRecord[] {
  const lines = text.split("\n").filter((l) => l.trim()).length;
  const records = parseRecords(text);
  if (records.length !== lines) throw new Error(`${name}: parsed ${records.length} of ${lines} non-blank lines`);
  const arms = new Set(records.map((r) => r.arm));
  for (const a of arms) if (a !== BASELINE && a !== TREATMENT) throw new Error(`${name}: unexpected arm "${a}"`);
  if (!arms.has(BASELINE) || !arms.has(TREATMENT)) throw new Error(`${name}: needs both the "${BASELINE}" and "${TREATMENT}" arm`);
  return records;
}

export function analyse(records: RunRecord[]): RepoResult {
  const comparison = compareArms(records, BASELINE, TREATMENT);
  return { repo: comparison.scope.repo, records, comparison };
}

// puts every task of every repo into one sample. The task id gets the repo as a prefix, so two tasks can never be paired just because their ids match
export function pool(repos: RepoResult[]): { name: string; comparison: Comparison } {
  const name = `all ${repos.length} repos`;
  const records = repos.flatMap((r) => r.records.map((x) => ({ ...x, repo: name, task: `${x.repo}#${x.task}` })));
  return { name, comparison: compareArms(records, BASELINE, TREATMENT) };
}

export interface Setup {
  line: string;
  sentence: string;
  model: string;
}

export function deriveSetup(repos: RepoResult[], pooled: Comparison): Setup {
  if (pooled.warnings.length > 0) throw new Error(`pooled comparison warns: ${pooled.warnings.join("; ")}`);
  if (pooled.excludedInfra > 0) throw new Error(`${pooled.excludedInfra} infrastructure failures were never run again`);
  const scope = pooled.scope;
  if (scope.modelsResolved.length !== 1) throw new Error(`expected one resolved model, found ${scope.modelsResolved.length}: ${scope.modelsResolved.join(", ")}`);
  if (scope.agentVersions.length !== 1) throw new Error(`expected one agent version, found ${scope.agentVersions.join(", ")}`);
  const settings = new Set(repos.flatMap((r) => r.records.map((x) => JSON.stringify(x.settings))));
  if (settings.size !== 1) throw new Error(`runs used ${settings.size} different settings`);
  const perRepo = new Set(repos.map((r) => JSON.stringify([r.comparison.scope.agentVersions, r.comparison.scope.modelsResolved, r.comparison.scope.sandboxes, r.comparison.scope.model])));
  if (perRepo.size !== 1) throw new Error("repos differ in agent version, model or sandbox");
  const reps = new Set(repos.map((r) => new Set(r.records.map((x) => x.rep)).size));
  if (reps.size !== 1) throw new Error("repos differ in the number of repetitions");
  const { budgetUsd, timeoutMs, sandbox } = JSON.parse([...settings][0]) as RunRecord["settings"];
  const where = sandbox === "docker" ? "Docker sandbox with the network limited to the model API" : "no sandbox";
  const model = scope.modelsResolved[0];
  const tool = /\(([^)]*)\)/.exec(scope.agentVersions[0] ?? "")?.[1] ?? scope.agent;
  const version = scope.agentVersions[0].replace(/\s*\(.*$/, "");
  const net = sandbox === "docker" ? "in a Docker sandbox whose network reaches only the model API" : "without a sandbox";
  return {
    model,
    sentence: `${tool} ${version} with ${model}, ${[...reps][0]} runs per task and arm, capped at $${budgetUsd} and ${timeoutMs / 60_000} minutes per run, ${net}.`,
    line: `${scope.agent} ${scope.agentVersions[0]}, model ${model}, ${[...reps][0]} runs per task and arm, $${budgetUsd} and ${timeoutMs / 60_000} minutes per run, ${where}`,
  };
}

const pts = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ratio = (x: number): string => (Number.isFinite(x) ? `${x.toFixed(2)}x` : "unbounded");
const range = (xs: number[], fmt: (x: number) => string): string => {
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
  return lo === hi ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`;
};

function row(name: string, c: Comparison): string {
  const [none, repo] = c.arms;
  const cost = c.costRatio ? `${ratio(c.costRatio.estimate)} (${ratio(c.costRatio.low)} to ${ratio(c.costRatio.high)})` : "n/a";
  return `| ${name} | ${c.pairedTasks} | ${none.runs + repo.runs} | ${pct(none.taskWeightedRate)} | ${pct(repo.taskWeightedRate)} | ${pts(c.successDiff.estimate)} | ${c.tasksBetter} / ${c.tasksWorse} | ${c.pValue.toFixed(2)} | ${cost} |`;
}

const runCounts = (cs: Comparison[]) => ({
  runs: cs.reduce((n, c) => n + c.arms[0].runs + c.arms[1].runs, 0),
  noCost: cs.reduce((n, c) => n + c.arms[0].unknownCost + c.arms[1].unknownCost, 0),
  timeouts: cs.reduce((n, c) => n + c.arms[0].timeouts + c.arms[1].timeouts, 0),
});

const short = (repo: string): string => repo.split("/")[1] ?? repo;

const missing = (c: Comparison): [number, number] => [c.arms[0].unknownCost, c.arms[1].unknownCost];

function censoringNote(repos: RepoResult[], pooled: Comparison): string {
  const withRange = repos.filter((r) => r.comparison.costRatioRange);
  const span = (c: Comparison, join: string) => `${ratio((c.costRatioRange as { low: number }).low)} ${join} ${ratio((c.costRatioRange as { high: number }).high)}`;
  const perRepo = withRange.map((r) => `${short(r.repo)} ${span(r.comparison, "to")}`).join(", ");
  return `If they had cost anything from $0 to their budget, the pooled ratio would lie between ${pooled.costRatioRange ? span(pooled, "and") : "n/a"}${perRepo ? `, and the ratio of ${withRange.length === 1 ? "that repo" : "each repo with such runs"} would be ${perRepo}` : ""}.`;
}

const day = (iso: string): string => iso.slice(0, 10);

export function renderTable(repos: RepoResult[], pooled: { name: string; comparison: Comparison }): string {
  const cs = repos.map((r) => r.comparison);
  const { runs, noCost, timeouts } = runCounts(cs);
  const retried = cs.reduce((n, c) => n + c.arms[0].infraRetried + c.arms[1].infraRetried, 0);
  const left = cs.reduce((n, c) => n + c.excludedInfra, 0);
  const windows = repos.flatMap((r) => (r.merged ? [`${short(r.repo)} ${r.merged[0]} to ${r.merged[1]}`] : []));
  const notes = [
    ...(windows.length > 0 ? [`The tasks were merged between these dates: ${windows.join(", ")}.`] : []),
    retried === 0 && left === 0
      ? "No run failed for infrastructure reasons."
      : `${retried} runs failed for infrastructure reasons and were run again; ${left === 0 ? "none were excluded" : `${left} were excluded`}.`,
    `Cost ratio is the mean cost per run with the context files divided by the mean cost per run without, over tasks. ${noCost === 0 ? "Every run reports a cost." : `${noCost} of ${runs} runs report no cost (${timeouts} timed out) and are left out of it. ${censoringNote(repos, pooled.comparison)}`}`,
    `The pooled row covers only these ${pooled.comparison.pairedTasks} tasks. The difference is averaged per task, so a repo with more tasks weighs more, and the pooled cost ratio is weighted toward expensive tasks.`,
  ];
  return [
    "| repo | tasks | runs (infra failures excluded) | solved without | solved with | difference (pts) | tasks better / worse | paired permutation p | cost ratio per run, with ÷ without (95% CI) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...repos.map((r) => row(`[${r.repo}](https://github.com/${r.repo})`, r.comparison)),
    row(`**${pooled.name}**`, pooled.comparison),
    "",
    ...notes.flatMap((n) => [n, ""]),
  ]
    .join("\n")
    .trimEnd();
}

export const RESULTS_CLOSING = "Merge dates, per-repo reports, cost caveats and the raw records are in [bench/RESULTS.md](bench/RESULTS.md).";

// the short block that goes into the README; the full table and notes live in RESULTS.md
export function renderCompact(repos: RepoResult[], pooled: { name: string; comparison: Comparison }, setup: Setup): string {
  const line = (name: string, c: Comparison): string => {
    const [none, repo] = c.arms;
    const cost = c.costRatio ? `${ratio(c.costRatio.estimate)} (${ratio(c.costRatio.low)} to ${ratio(c.costRatio.high)})` : "n/a";
    return `| ${name} | ${c.pairedTasks} | ${pct(none.taskWeightedRate)} | ${pct(repo.taskWeightedRate)} | ${pts(c.successDiff.estimate)} pts | ${c.pValue.toFixed(2)} | ${cost} |`;
  };
  return [
    setup.sentence,
    "",
    "| repo | tasks | solved without | solved with | difference | p | cost per run, with ÷ without |",
    "|---|---|---|---|---|---|---|",
    ...repos.map((r) => line(`[${r.repo}](https://github.com/${r.repo})`, r.comparison)),
    line(`**${pooled.name}**`, pooled.comparison),
    "",
    RESULTS_CLOSING,
  ].join("\n");
}

function repoCaveats(repos: RepoResult[]): string[] {
  return repos.flatMap((r) => {
    const c = r.comparison;
    const [a, b] = missing(c);
    if (!c.costRatioRange || a + b === 0) return [];
    const below = c.costRatioRange.low <= 1 ? ", including below 1.0x" : "";
    const where = a === 0 ? "all of them are in the arm with context files, so the ratio is likely an underestimate" : b === 0 ? "all of them are in the arm without context files, so the ratio is likely an overestimate" : `${a} are in the arm without context files and ${b} in the arm with them`;
    return [`In ${short(r.repo)} the ${a + b} run${a + b === 1 ? "" : "s"} without cost data could move the ratio anywhere from ${ratio(c.costRatioRange.low)} to ${ratio(c.costRatioRange.high)}${below}; ${where}.`];
  });
}

function detectionLimit(cs: Comparison[], digits: number): { tasks: string; points: string } | null {
  const known = cs.filter((c) => c.minDetectableDiff !== null);
  if (known.length === 0) return null;
  return { tasks: range(known.map((c) => c.pairedTasks), String), points: range(known.map((c) => (c.minDetectableDiff as number) * 100), (x) => x.toFixed(digits)) };
}

export function findings(repos: RepoResult[], pooled: Comparison): string {
  const cs = repos.map((r) => r.comparison);
  const withCost = repos.filter((r) => r.comparison.costRatio);
  const costs = withCost.map((r) => r.comparison.costRatio as Interval);
  const allAbove = costs.every((i) => i.low > 1);
  const crossing = withCost.filter((r) => (r.comparison.costRatio as Interval).low <= 1).map((r) => r.repo);
  const { runs, noCost, timeouts } = runCounts(cs);
  const p = pooled.pValue;
  const limit = detectionLimit(cs, 1);
  const paragraphs: string[] = [];

  const diffs = cs.map((c) => c.successDiff.estimate);
  paragraphs.push(
    `The pooled success difference over ${pooled.pairedTasks} tasks is ${pts(pooled.successDiff.estimate)} points (95% CI ${pts(pooled.successDiff.low)} to ${pts(pooled.successDiff.high)}), with a paired permutation p of ${p.toFixed(2)}, which is ${p < 0.05 ? "significant" : "not significant"} at the 0.05 level. Per repo it ranges from ${pts(Math.min(...diffs))} to ${pts(Math.max(...diffs))} points.`,
  );


  const caveats = repoCaveats(repos);
  paragraphs.push(
    costs.length === 0
      ? "No repo has enough cost data for a cost ratio."
      : `Per repo, a run with the context files cost ${range(costs.map((i) => i.estimate), ratio)} as much as a run without${pooled.costRatio ? ` (${ratio(pooled.costRatio.estimate)} pooled, 95% CI ${ratio(pooled.costRatio.low)} to ${ratio(pooled.costRatio.high)})` : ""}. ${
          allAbove ? "Every repo's interval is above 1.0x" : `The interval of ${crossing.join(" and ")} includes 1.0x`
        }${noCost === 0 ? ", and every run reports a cost." : `, but ${noCost} of the ${runs} runs have no cost data${noCost === timeouts ? " because they timed out" : ` (${timeouts} of them timed out)`} and are left out of the cost figures. ${caveats.join(" ")}${pooled.costRatioRange ? ` Pooled, the ratio would lie between ${ratio(pooled.costRatioRange.low)} and ${ratio(pooled.costRatioRange.high)} if those runs cost anything from $0 to their budget.` : ""}`}`,
  );

  if (limit) {
    paragraphs.push(
      `With ${limit.tasks} tasks per repo, a single repo's runs would only reliably detect differences of about ${limit.points} points (80% power at the 0.05 level). These figures are estimated from the observed spread of per-task differences, so they are optimistic when almost all tasks tie. Per-repo bootstrap intervals on about 25 tasks tend to be too narrow; read them together with the paired permutation p.`,
    );
  }
  return paragraphs.join("\n\n");
}

export function headline(repos: RepoResult[], pooled: Comparison, setup: Setup): string {
  const { runs } = runCounts(repos.map((r) => r.comparison));
  const tool = /\(([^)]*)\)/.exec(pooled.scope.agentVersions[0] ?? "")?.[1] ?? pooled.scope.agent;
  const d = pooled.successDiff;
  const interval = `${pts(d.estimate)} points, 95% CI ${pts(d.low)} to ${pts(d.high)}, p = ${pooled.pValue.toFixed(2)}`;
  const success =
    pooled.pValue >= 0.05
      ? `the context files did not measurably change how often tasks were solved (${interval})`
      : d.low > 0 || d.high < 0
        ? `tasks were solved ${d.estimate > 0 ? "more" : "less"} often with the context files (${interval})`
        : `the difference in how often tasks were solved with the context files was ${pts(d.estimate)} points (${interval})`;
  const c = pooled.costRatio;
  const cost = c ? `, and each run cost ${ratio(c.estimate)} as much with them (95% CI ${ratio(c.low)} to ${ratio(c.high)}${c.low <= 1 ? ", which includes 1.0x" : ""})` : "";
  return `Across ${pooled.pairedTasks} tasks from ${repos.length} repos (${runs} runs, ${tool} with ${setup.model}), ${success}${cost}.`;
}

export const RESULTS_MARKERS = ["<!-- results:start -->", "<!-- results:end -->"] as const;
export const FINDINGS_MARKERS = ["<!-- findings:start -->", "<!-- findings:end -->"] as const;
export const HEADLINE_MARKERS = ["<!-- headline:start -->", "<!-- headline:end -->"] as const;

// throws before anything is written. headline and results markers are required; findings markers are optional and skipped when absent
export function spliceReadme(readme: string, table: string, findingsText: string, headlineText: string): string {
  let text = readme;
  for (const [[start, end], body, optional] of [
    [RESULTS_MARKERS, table, false],
    [FINDINGS_MARKERS, findingsText, true],
    [HEADLINE_MARKERS, headlineText, false],
  ] as const) {
    const [a, b] = [text.indexOf(start), text.indexOf(end)];
    if (optional && a < 0 && b < 0) continue;
    if (a < 0 || b < a || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error(`README.md needs exactly one ${start} before one ${end}`);
    text = `${text.slice(0, a + start.length)}\n\n${body}\n\n${text.slice(b)}`;
  }
  return text;
}

export function renderResults(repos: RepoResult[], pooled: { name: string; comparison: Comparison }, setup: Setup): string {
  const findingsText = findings(repos, pooled.comparison);
  const sections = [...repos.map((r) => ({ name: r.repo, c: r.comparison })), { name: `${pooled.name} (pooled)`, c: pooled.comparison }];
  return [
    "# Results",
    "",
    "Generated by `node bench/summarize.ts` from the run records in `bench/data`. Do not edit by hand.",
    "",
    `Setup: ${setup.line}. The arms are \`repo\` (context files as they were at each task's base commit) and \`none\` (every AGENTS.md and CLAUDE.md removed).`,
    "",
    renderTable(repos, pooled),
    "",
    "## Findings",
    "",
    findingsText,
    "",
    ...sections.flatMap(({ name, c }) => [`## ${name}`, "", formatComparison(c).replace(/^## /, "### "), ""]),
  ].join("\n");
}

export interface ChartItem {
  name: string;
  c: Comparison;
  bold: boolean;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const round = (x: number): number => Math.round(x * 1e6) / 1e6;

interface Axis {
  lo: number;
  hi: number;
  ticks: number[];
}

export function axis(values: number[], anchor: number, cap: [number, number], steps: number[]): Axis {
  const finite = values.filter(Number.isFinite);
  const lo0 = Math.min(anchor, ...finite);
  const hi0 = Math.max(anchor, ...finite);
  const pad = (hi0 - lo0) * 0.05 || steps[0];
  const step = steps.find((s) => (hi0 - lo0 + 2 * pad) / s <= 6) ?? steps[steps.length - 1];
  const lo = Math.max(cap[0], round(Math.floor((lo0 - pad) / step) * step));
  const hi = Math.min(cap[1], round(Math.ceil((hi0 + pad) / step) * step));
  const ticks: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) ticks.push(round(k * step));
  return { lo, hi, ticks };
}

const minus = (n: number): string => (n < 0 ? `−${-n}` : n > 0 ? `+${n}` : "0");

export function chart(items: ChartItem[], model: string): string {
  const W = 780;
  const rowH = 34;
  const top = 56;
  const labelW = 150;
  const panelW = (W - labelW - 60) / 2;
  const H = top + items.length * rowH + 40;
  const p1 = labelW;
  const p2 = labelW + panelW + 40;
  const diffs = items.flatMap(({ c }) => [c.successDiff.estimate, c.successDiff.low, c.successDiff.high]);
  const costs = items.flatMap(({ c }) => (c.costRatio ? [c.costRatio.estimate, c.costRatio.low, c.costRatio.high] : []));
  const ax1 = axis(diffs, 0, [-1, 1], [0.05, 0.1, 0.2, 0.25, 0.5]);
  const ax2 = axis(costs, 1, [0.5, 4], [0.1, 0.2, 0.25, 0.5, 1]);
  const scale = (a: Axis, x0: number) => (v: number) => x0 + ((v - a.lo) / (a.hi - a.lo)) * panelW;
  const sx = scale(ax1, p1);
  const cx = scale(ax2, p2);
  const out: string[] = [];

  const desc = items
    .map(({ name, c }) => {
      const d = c.successDiff;
      const r = c.costRatio;
      return `${name}: success difference ${pts(d.estimate)} points (95% interval ${pts(d.low)} to ${pts(d.high)}), cost ratio ${r ? `${ratio(r.estimate)} (${ratio(r.low)} to ${ratio(r.high)})` : "n/a"}.`;
    })
    .join(" ");
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13">`);
  out.push(`<title id="t">Success difference and cost ratio of runs with and without context files, per repo</title>`);
  out.push(`<desc id="d">${esc(desc)}</desc>`);
  out.push(`<style>.bg{fill:#ffffff}text{fill:#1f2328}.muted{fill:#59636e}.axis{stroke:#d1d9e0}.ref{stroke:#59636e;stroke-dasharray:3 3}.ci{stroke:#0969da;stroke-width:2;fill:none}.dot{fill:#0969da}.ci.cost{stroke:#bc4c00}.dot.cost{fill:#bc4c00}@media (prefers-color-scheme:dark){.bg{fill:#0d1117}text{fill:#e6edf3}.muted{fill:#9198a1}.axis{stroke:#3d444d}.ref{stroke:#9198a1}.ci{stroke:#4493f8}.dot{fill:#4493f8}.ci.cost{stroke:#f0883e}.dot.cost{fill:#f0883e}}</style>`);
  out.push(`<rect width="${W}" height="${H}" rx="6" class="bg"/>`);
  out.push(`<text x="${p1}" y="20" font-weight="600">Success rate, with minus without (pts)</text>`);
  out.push(`<text x="${p2}" y="20" font-weight="600">Cost per run, with / without</text>`);
  for (const t of ax1.ticks) out.push(`<text x="${sx(t)}" y="44" text-anchor="middle" class="muted" font-size="11">${minus(Math.round(t * 100))}</text>`);
  for (const t of ax2.ticks) out.push(`<text x="${cx(t)}" y="44" text-anchor="middle" class="muted" font-size="11">${t.toFixed(1)}x</text>`);
  const bottom = top + items.length * rowH - 10;
  out.push(`<line x1="${sx(0)}" y1="${top - 8}" x2="${sx(0)}" y2="${bottom}" class="ref"/>`);
  out.push(`<line x1="${cx(1)}" y1="${top - 8}" x2="${cx(1)}" y2="${bottom}" class="ref"/>`);

  // anything beyond the axis is drawn at its edge with an open arrow
  const mark = (v: Interval, scaleFn: (x: number) => number, x0: number, y: number, cls: string): void => {
    const x1 = x0 + panelW;
    const at = (x: number) => Math.min(x1, Math.max(x0, x));
    const arrow = (x: number, dir: 1 | -1) => out.push(`<path d="M${x - 5 * dir} ${y - 5} L${x} ${y} L${x - 5 * dir} ${y + 5}" class="ci ${cls}"/>`);
    if (!Number.isNaN(v.low) && !Number.isNaN(v.high)) {
      out.push(`<line x1="${at(scaleFn(v.low))}" y1="${y}" x2="${at(scaleFn(v.high))}" y2="${y}" class="ci ${cls}"/>`);
      if (scaleFn(v.low) < x0) arrow(x0, -1);
      if (scaleFn(v.high) > x1) arrow(x1, 1);
    }
    if (Number.isNaN(v.estimate)) return;
    const dx = scaleFn(v.estimate);
    out.push(`<circle cx="${at(dx)}" cy="${y}" r="5" class="dot ${cls}"/>`);
    if (dx < x0 && Number.isNaN(v.low)) arrow(x0, -1);
    if (dx > x1 && Number.isNaN(v.high)) arrow(x1, 1);
  };

  items.forEach(({ name, c, bold }, i) => {
    const y = top + i * rowH + 8;
    out.push(`<text x="${labelW - 12}" y="${y + 4}" text-anchor="end"${bold ? ' font-weight="600"' : ""}>${esc(name)}</text>`);
    out.push(`<line x1="${p1}" y1="${y}" x2="${p1 + panelW}" y2="${y}" class="axis"/>`);
    out.push(`<line x1="${p2}" y1="${y}" x2="${p2 + panelW}" y2="${y}" class="axis"/>`);
    mark(c.successDiff, sx, p1, y, "");
    if (c.costRatio) mark(c.costRatio, cx, p2, y, "cost");
  });
  out.push(`<text x="${p1}" y="${H - 12}" class="muted" font-size="11">${esc(`Dots are estimates, lines are 95% bootstrap intervals over tasks. Arrows mark values beyond the axis. Model ${model}.`)}</text>`);
  out.push("</svg>");
  return out.join("\n");
}

export function chartItems(repos: RepoResult[], pooled: { name: string; comparison: Comparison }): ChartItem[] {
  return [...repos.map((r) => ({ name: r.repo.split("/")[1], c: r.comparison, bold: false })), { name: pooled.name, c: pooled.comparison, bold: true }];
}

function mergeWindow(tasksFile: string, records: RunRecord[]): [string, string] {
  const used = new Set(records.map((r) => r.task));
  const dates = (JSON.parse(readFileSync(tasksFile, "utf8")) as { id: string; mergedAt: string }[]).filter((t) => used.has(t.id)).map((t) => day(t.mergedAt)).sort();
  if (dates.length === 0) throw new Error(`${tasksFile} has none of the tasks in the records`);
  return [dates[0], dates[dates.length - 1]];
}

export function build(root: string): { readme: string; results: string; svg: string } {
  const dataDir = join(root, "bench", "data");
  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) throw new Error(`no .jsonl files in ${dataDir}`);
  const repos = files.map((f) => {
    const r = analyse(parseStrict(readFileSync(join(dataDir, f), "utf8"), f));
    return { ...r, merged: mergeWindow(join(root, "bench", "tasks", f.replace(/\.jsonl$/, ".json")), r.records) };
  });
  const pooled = pool(repos);
  const setup = deriveSetup(repos, pooled.comparison);
  const table = renderCompact(repos, pooled, setup);
  return {
    readme: spliceReadme(readFileSync(join(root, "README.md"), "utf8"), table, findings(repos, pooled.comparison), headline(repos, pooled.comparison, setup)),
    results: renderResults(repos, pooled, setup),
    svg: chart(chartItems(repos, pooled), setup.model),
  };
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  // everything is built before anything is written, so a bad README leaves the files as they were
  const out = build(root);
  writeFileSync(join(root, "bench", "RESULTS.md"), out.results);
  writeFileSync(join(root, "bench", "results.svg"), out.svg);
  writeFileSync(join(root, "README.md"), out.readme);
  console.log("wrote bench/RESULTS.md, bench/results.svg and the README headline and results table");
}
