import type { Comparison, Interval } from "./stats.ts";

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signedPts = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
const usd = (x: number | null): string => (x === null ? "n/a" : `$${x.toFixed(3)}`);

function ci(i: Interval, fmt: (x: number) => string): string {
  return Number.isNaN(i.low) ? fmt(i.estimate) : `${fmt(i.estimate)} (95% CI ${fmt(i.low)} to ${fmt(i.high)})`;
}

export function formatComparison(c: Comparison): string {
  const rows = c.arms.map(
    (a) =>
      `| ${a.arm} | ${a.runs} | ${pct(a.taskWeightedRate)} | ${usd(a.meanCostUsd)} | ${usd(a.costPerResolvedUsd)} | ${a.contaminated} | ${a.suspect} | ${a.timeouts} | ${a.agentLimits + a.agentErrors} | ${a.infra}${a.infraRetried > 0 ? ` (+${a.infraRetried} retried)` : ""} |`,
  );
  const tied = c.pairedTasks - c.tasksBetter - c.tasksWorse;
  const lines = [
    `## ${c.treatment} vs ${c.baseline}`,
    "",
    `${c.scope.repo} · ${c.scope.agent} ${c.scope.agentVersions.join(", ")} · model ${c.scope.modelsResolved.join(", ") || c.scope.model}`,
    "",
    c.scope.sandboxes.every((m) => m === "docker")
      ? "Resolved means the PR's hidden tests pass, within each run's budget and time limit, with the network limited to the model API."
      : "Resolved means the PR's hidden tests pass, within each run's budget and time limit. Some runs had no sandbox, so the agent had network access.",
    "",
    "| arm | runs | resolved (per task) | cost / run | cost / resolved | contaminated | suspect | timeouts | limit or error | infra (excluded) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `- Tasks compared: ${c.pairedTasks} (${c.tasksBetter} better with ${c.treatment}, ${c.tasksWorse} worse, ${tied} tied)`,
    `- Success rate difference (${c.treatment} - ${c.baseline}): ${ci(c.successDiff, signedPts)}, paired permutation p = ${c.pValue.toFixed(3)}`,
    `- Smallest difference this run could reliably detect: ${c.minDetectableDiff === null ? "n/a (too few tasks or no variation)" : `about ±${(c.minDetectableDiff * 100).toFixed(1)} pts`}`,
    `- Without runs the audit flagged${c.scope.sandboxes.every((m) => m === "docker") ? " (in the sandbox, suspect commands could not reach the network)" : ""}: ${c.sensitivityExcludingFlagged === null ? "n/a" : signedPts(c.sensitivityExcludingFlagged)}`,
    ...(c.sensitivityInfraAsFailure === null ? [] : [`- Counting unresolved infrastructure failures as failed attempts: ${signedPts(c.sensitivityInfraAsFailure)}`]),
    `- Cost ratio per run (${c.treatment} / ${c.baseline}): ${c.costRatio ? ci(c.costRatio, (x) => `${x.toFixed(2)}x`) : "n/a"}`,
    "- Contaminated runs count as failures. Suspect runs are scored by their tests and left out of the line without flagged runs.",
    `- Runs left out for infrastructure failures: ${c.excludedInfra}`,
    "- Tasks that `run` skipped before starting (same context in every arm, or a possible leak through the head arm) are not counted here.",
  ];
  if (c.identicalArmTasks > 0) {
    lines.push(`- ${c.identicalArmTasks} tasks left out because both arms saw the same context files (usually because the file didn't exist yet at that commit)`);
  }
  const unknown = c.arms.reduce((n, a) => n + a.unknownCost, 0);
  const capped = c.arms.reduce((n, a) => n + a.budgetCapped, 0);
  if (unknown > 0) {
    const hi = c.costRatioRange && Number.isFinite(c.costRatioRange.high) ? `${c.costRatioRange.high.toFixed(2)}x` : "unbounded";
    const range = c.costRatioRange ? ` If they cost anything between $0 and their budget, the cost ratio lies between ${c.costRatioRange.low.toFixed(2)}x and ${hi}.` : "";
    lines.push(`- ${unknown} runs have no cost data and are left out of the cost figures.${range}`);
  }
  if (capped > 0) lines.push(`- ${capped} runs stopped at the budget and count at the cost they reported.`);
  if (c.tasksOnlyInfra > 0) {
    lines.push(`- ${c.tasksOnlyInfra} tasks are left out because every run in one arm failed for infrastructure reasons; the line counting infrastructure failures includes them.`);
  }
  if (c.tasksWithoutCost > 0) lines.push(`- ${c.tasksWithoutCost} tasks are left out of the cost ratio because one arm has no run with cost data.`);
  for (const w of c.warnings) lines.push(`- Warning: ${w}`);
  if (c.armsInResults.length > 2) {
    lines.push(`- The results hold ${c.armsInResults.length} arms (${c.armsInResults.join(", ")}). Report every comparison you ran.`);
  }
  if (c.scope.modelsResolved.length > 1) lines.push(`- Warning: the model alias resolved to several models (${c.scope.modelsResolved.join(", ")})`);
  if (c.scope.agentVersions.length > 1) lines.push(`- Warning: runs span several agent versions (${c.scope.agentVersions.join(", ")})`);
  if (c.pairedTasks < 30) lines.push(`- With ${c.pairedTasks} tasks the bootstrap interval tends to be too narrow; read it with the permutation p-value`);
  const ciIncludesZero = !Number.isNaN(c.successDiff.low) && c.successDiff.low <= 0 && c.successDiff.high >= 0;
  if (ciIncludesZero || c.pValue >= 0.05) {
    const mde = c.minDetectableDiff === null ? "" : ` Differences smaller than about ±${(c.minDetectableDiff * 100).toFixed(1)} pts can't be ruled out.`;
    lines.push("", `This data does not show a difference in success rate.${mde}`);
  }
  return lines.join("\n");
}
