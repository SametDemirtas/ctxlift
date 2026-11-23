import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARMS } from "../src/arms.ts";
import { isoDate, nonNegativeInt, positiveInt, positiveNumber, splitCommand } from "../src/args.ts";
import { buildPlan, runKey, settingsHash } from "../src/pipeline/plan.ts";
import { formatComparison } from "../src/report.ts";
import { latestByKey, parseRecords } from "../src/results/records.ts";
import { ResultsStore } from "../src/results/store.ts";
import { bootstrap, compareArms, signFlipPValue } from "../src/stats.ts";
import type { RunKind, RunRecord, ValidTask } from "../src/types.ts";

const S = { budgetUsd: 2, timeoutMs: 1000, sandbox: "docker", headRev: "h" };
const tasks = ["t1", "t2", "t3"].map((id) => ({ id, repo: "o/r", failToPass: ["x"] }) as unknown as ValidTask);

test("plan: reps outermost, every task x arm once per rep, arm order varies and is reproducible", () => {
  const p = buildPlan(tasks, [ARMS.repo, ARMS.none], 4, 7, "claude-code", "sonnet", S);
  assert.equal(p.length, 24);
  assert.deepEqual(p.map((i) => i.rep), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
  assert.equal(new Set(p.map((i) => i.key)).size, 24);
  assert.equal(p[0].key.split("|").length, 7);
  assert.notEqual(buildPlan(tasks, [ARMS.repo, ARMS.none], 1, 7, "claude-code", "sonnet", { ...S, budgetUsd: 5 })[0].key, p[0].key, "a different budget is a different run");
  assert.equal(settingsHash(S), settingsHash({ ...S }));
  assert.match(p[0].key, /^o\/r\|/);
  assert.match(p[0].key, /\|claude-code\|sonnet\|[0-9a-f]{8}$/);
  const firsts = p.filter((_, i) => i % 2 === 0).map((i) => i.arm.id);
  assert.ok(firsts.includes("repo") && firsts.includes("none"), "neither arm always goes first");
  assert.deepEqual(buildPlan(tasks, [ARMS.repo, ARMS.none], 4, 7, "claude-code", "sonnet", S).map((i) => i.key), p.map((i) => i.key));
  assert.notDeepEqual(buildPlan(tasks, [ARMS.repo, ARMS.none], 1, 1, "claude-code", "opus", S)[0].key, p[0].key);
});

const rec = (task: string, arm: string, rep: number, resolved: boolean, cost: number | null, kind: RunKind = "completed", contaminated = false, model = "m"): RunRecord => ({
  key: runKey("o/r", task, arm, rep, "a", model, S), repo: "o/r", task, arm, rep, agent: "a", agentVersion: "1", model, kind, subtype: null, resolved,
  f2pPassed: 0, f2pTotal: 1, p2pBroken: 0, contaminated, audit: [], suspect: [], gradingNote: null, limit: null, modelResolved: null, settings: S,
  contextFiles: arm === "repo" ? [{ path: "AGENTS.md", bytes: 5, sha256: "x" }] : [], error: null, at: "",
  usage: { costUsd: cost, turns: null, durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
});

test("store: resume skips finished runs, retries infra, survives a truncated last line", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-store-"));
  try {
    const path = join(dir, "nested", "runs.jsonl");
    const s = new ResultsStore(path);
    s.append(rec("t1", "repo", 0, true, 1));
    s.append(rec("t1", "none", 0, false, null, "infra"));
    appendFileSync(path, '{"key":"t2|repo|0","kin');
    s.append(rec("t2", "none", 0, false, 2));
    assert.deepEqual([...s.completedKeys()].sort(), [runKey("o/r", "t1", "repo", 0, "a", "m", S), runKey("o/r", "t2", "none", 0, "a", "m", S)]);
    assert.equal(s.load().length, 3);
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 4, "the partial line is kept but isolated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(parseRecords('\n{"a":1}\n[]\n').length, 0);
});

test("store: latestByKey keeps the retry that succeeded, not the infra failure before it", () => {
  const first = rec("t1", "repo", 0, false, null, "infra");
  const retry = rec("t1", "repo", 0, true, 1);
  const lateInfra = rec("t1", "repo", 0, false, null, "infra");
  assert.deepEqual(latestByKey([first, retry, lateInfra]), [retry]);
  assert.deepEqual(latestByKey([first]), [first]);
});

test("stats: paired difference, contaminated counted as failure, retried infra not double counted", () => {
  const rs = [
    rec("t1", "none", 0, false, 1), rec("t1", "none", 1, true, 1), rec("t1", "repo", 0, true, 2), rec("t1", "repo", 1, true, 2),
    rec("t2", "none", 0, true, 1), rec("t2", "repo", 0, false, null, "infra"), rec("t2", "repo", 0, true, 2),
    rec("t3", "none", 0, false, 1), rec("t3", "repo", 0, false, null, "infra"),
    rec("t2", "repo", 1, true, 2, "completed", true),
  ];
  const c = compareArms(rs, "none", "repo", 500, 3);
  assert.equal(c.pairedTasks, 2, "t3 has no usable repo run");
  assert.equal(c.excludedInfra, 1, "t2's infra run was retried successfully; t3's repo run is still infra");
  assert.equal(c.tasksOnlyInfra, 1, "t3 is left out because its only repo run was infra");
  assert.equal(c.arms[1].infraRetried, 1, "the replaced infra run is still counted, per arm");
  assert.equal(c.successDiff.estimate, 0, "t1: 1 - 0.5 = +0.5; t2: (1 + 0)/2 - 1 = -0.5 because the contaminated pass counts as a failure");
  assert.equal(c.tasksBetter, 1);
  assert.equal(c.tasksWorse, 1);
  assert.equal(c.arms[1].contaminated, 1);
  assert.equal(c.costRatio?.estimate, 2);
  assert.deepEqual(c.scope, { repo: "o/r", agent: "a", model: "m", agentVersions: ["1"], modelsResolved: [], sandboxes: ["docker"] });
  const md = formatComparison(c);
  assert.match(md, /\+0\.0 pts/);
  assert.match(md, /2\.00x/);
  assert.match(md, /does not show a difference/);
  assert.throws(() => compareArms([rec("t1", "none", 0, true, 1)], "none", "repo"), /no task has usable runs/);
});

test("stats: tasks where both arms saw the same context are left out and counted", () => {
  const same = { ...rec("t2", "repo", 0, true, 1), contextFiles: [] };
  const c = compareArms([rec("t1", "none", 0, false, 1), rec("t1", "repo", 0, true, 1), rec("t2", "none", 0, false, 1), same], "none", "repo", 200, 1);
  assert.equal(c.pairedTasks, 1);
  assert.equal(c.identicalArmTasks, 1);
  assert.equal(c.minDetectableDiff, null, "one task: no spread to estimate");
  assert.match(formatComparison(c), /left out because both arms saw the same context/);
});

test("stats: suspect runs are scored by their tests, and the sensitivity line leaves them out", () => {
  const sus = { ...rec("t1", "repo", 1, true, 1), suspect: ["Bash: pip install x"] };
  const rs = [rec("t1", "none", 0, false, 1), rec("t1", "repo", 0, false, 1), sus, rec("t2", "none", 0, false, 1), rec("t2", "repo", 0, true, 1)];
  const c = compareArms(rs, "none", "repo", 200, 1);
  assert.equal(c.successDiff.estimate, 0.75, "t1: 0.5, t2: 1");
  assert.equal(c.sensitivityExcludingFlagged, 0.5, "t1 without the suspect run: 0; t2: 1");
  assert.equal(c.arms[1].suspect, 1);
});

test("stats: refuses to mix models", () => {
  const rs = [rec("t1", "none", 0, true, 1), rec("t1", "repo", 0, true, 1, "completed", false, "other")];
  assert.throws(() => compareArms(rs, "none", "repo"), /mix several models/);
});

test("stats: sign-flip permutation p-values", () => {
  assert.equal(signFlipPValue([0, 0, 0]), 1);
  assert.equal(signFlipPValue([1, 1, 1, 1, 1]), 2 / 32, "all positive: only the two all-same-sign flips are as extreme");
  assert.equal(signFlipPValue([1, -1]), 1);
  const big = Array.from({ length: 30 }, () => 0.5);
  assert.ok(signFlipPValue(big, 1, 20_000) < 0.001);
});

test("bootstrap of a constant has a zero-width interval", () => {
  const i = bootstrap([1, 1, 1], (s) => s.reduce((a, b) => a + b, 0) / s.length, 200, 1);
  assert.deepEqual(i, { estimate: 1, low: 1, high: 1 });
});

test("args: command splitting and number validation", () => {
  assert.deepEqual(splitCommand(`uv run --frozen pytest -k "a and b" --x='y z' a\\ b ""`), ["uv", "run", "--frozen", "pytest", "-k", "a and b", "--x=y z", "a b", ""]);
  assert.throws(() => splitCommand(`pytest "open`), /unterminated/);
  assert.equal(positiveInt("reps", "3", 1), 3);
  assert.equal(positiveInt("reps", undefined, 5), 5);
  assert.throws(() => positiveInt("reps", "0", 1));
  assert.throws(() => positiveInt("reps", "2.5", 1));
  assert.equal(nonNegativeInt("seed", "0", 1), 0);
  assert.throws(() => nonNegativeInt("seed", "-1", 1));
  assert.equal(positiveNumber("budget", "0.5", 2), 0.5);
  assert.throws(() => positiveNumber("budget", "-1", 2));
  assert.equal(isoDate("since", "2026-08-01", "x"), "2026-08-01");
  assert.throws(() => isoDate("since", "08/01/2026", "x"));
});

test("stats: cost range brackets runs without cost between $0 and the budget", () => {
  const rs = [rec("t1", "none", 0, true, 1), rec("t1", "repo", 0, false, null, "timeout"), rec("t1", "repo", 1, true, 1)];
  const c = compareArms(rs, "none", "repo", 100, 1);
  assert.deepEqual(c.costRatioRange, { low: 0.5, high: 1.5 }, "repo: (0 + 1)/2 = 0.5 or (2 + 1)/2 = 1.5, vs none 1");
});

test("stats: warns about mixed settings and context that drifted between repetitions", () => {
  const other = { ...rec("t1", "repo", 1, true, 1), settings: { ...S, budgetUsd: 9 } };
  const drift = { ...rec("t1", "repo", 2, true, 1), contextFiles: [{ path: "AGENTS.md", bytes: 6, sha256: "y" }] };
  const c = compareArms([rec("t1", "none", 0, false, 1), rec("t1", "repo", 0, true, 1), other, drift], "none", "repo", 100, 1);
  assert.ok(c.warnings.some((w) => /different settings/.test(w)));
  assert.ok(c.warnings.some((w) => /different context files across repetitions/.test(w)));
  assert.match(formatComparison(c), /Warning: runs used/);
});

test("stats: unresolved infra failures get their own sensitivity line and an imbalance warning", () => {
  const rs = [
    rec("t1", "none", 0, true, 1), rec("t1", "repo", 0, true, 1),
    rec("t1", "repo", 1, false, null, "infra"), rec("t1", "repo", 2, false, null, "infra"),
  ];
  const c = compareArms(rs, "none", "repo", 100, 1);
  assert.equal(c.successDiff.estimate, 0);
  assert.equal(c.sensitivityInfraAsFailure, 1 / 3 - 1, "repo: 1 pass of 3 if infra counts as failure");
  assert.ok(c.warnings.some((w) => /infrastructure failures differ/.test(w)));
  assert.match(formatComparison(c), /Counting unresolved infrastructure failures as failed attempts/);
});

test("stats: a task whose runs in one arm all failed for infrastructure reasons is reported, not lost", () => {
  const rs = [
    rec("t1", "none", 0, true, 1), rec("t1", "repo", 0, true, 1),
    rec("e", "none", 0, true, 1), rec("e", "repo", 0, false, null, "infra"), rec("e", "repo", 1, false, null, "infra"),
  ];
  const c = compareArms(rs, "none", "repo", 100, 1);
  assert.equal(c.pairedTasks, 1);
  assert.equal(c.tasksOnlyInfra, 1);
  assert.equal(c.excludedInfra, 2);
  assert.equal(c.sensitivityInfraAsFailure, -0.5, "t1: 0, e: 0 - 1");
  assert.match(formatComparison(c), /every run in one arm failed for infrastructure reasons/);
});
