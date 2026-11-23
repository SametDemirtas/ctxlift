import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { compareArms } from "../src/stats.ts";
import { analyse, build, axis, chart, chartItems, deriveSetup, findings, headline, parseStrict, pool, renderCompact, renderResults, renderTable, spliceReadme, RESULTS_CLOSING } from "../bench/summarize.ts";
import type { RunRecord } from "../src/types.ts";

function rec(repo: string, task: string, arm: string, rep: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    key: `${repo}|${task}|${arm}|${rep}`, repo, task, arm, rep, agent: "claude", agentVersion: "2.1.0 (Claude Code) (docker)", model: "sonnet",
    kind: "completed", subtype: "success", resolved: arm === "repo" ? rep < 2 : rep < 1, f2pPassed: 1, f2pTotal: 1, p2pBroken: 0, contaminated: false,
    audit: [], suspect: [], gradingNote: null, limit: null, modelResolved: "claude-test-1",
    settings: { budgetUsd: 2, timeoutMs: 1_800_000, sandbox: "docker", headRev: "" },
    contextFiles: arm === "repo" ? [{ path: "CLAUDE.md", bytes: 10, sha256: "abc" }] : [],
    usage: { costUsd: arm === "repo" ? 0.3 : 0.2, turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    error: null, at: "2026-11-01T00:00:00Z", ...over,
  } as RunRecord;
}

const repoRecords = (repo: string, tasks: string[], over: Partial<RunRecord> = {}): RunRecord[] =>
  tasks.flatMap((t) => [0, 1, 2].flatMap((rep) => ["none", "repo"].map((arm) => rec(repo, t, arm, rep, over))));
const jsonl = (rs: RunRecord[]): string => `${rs.map((r) => JSON.stringify(r)).join("\n")}\n`;

const two = () => [analyse(repoRecords("a/one", ["t1", "t2", "t3"])), analyse(repoRecords("b/two", ["t1", "t2", "t3"]))];

test("strict parsing rejects corrupt lines and extra arms", () => {
  const good = jsonl(repoRecords("a/one", ["t1"]));
  assert.equal(parseStrict(good, "x").length, 6);
  assert.throws(() => parseStrict(`${good}{"key":\n`, "x"), /parsed 6 of 7/);
  assert.throws(() => parseStrict(jsonl([...repoRecords("a/one", ["t1"]), rec("a/one", "t1", "head", 0)]), "x"), /unexpected arm "head"/);
  assert.throws(() => parseStrict(jsonl(repoRecords("a/one", ["t1"]).filter((r) => r.arm === "none")), "x"), /both/);
});

test("pooling keeps equal task ids from different repos apart", () => {
  const repos = two();
  const pooled = pool(repos);
  assert.equal(pooled.comparison.pairedTasks, 6);
  assert.equal(pooled.name, "all 2 repos");
});

test("setup line comes from the records", () => {
  const repos = two();
  const setup = deriveSetup(repos, pool(repos).comparison);
  assert.equal(setup.model, "claude-test-1");
  assert.match(setup.line, /claude 2\.1\.0 \(Claude Code\) \(docker\), model claude-test-1, 3 runs per task and arm, \$2 and 30 minutes per run, Docker sandbox/);
});

test("setup derivation throws on mixed models, versions or settings", () => {
  const mixed = (over: Partial<RunRecord>) => {
    const repos = [analyse(repoRecords("a/one", ["t1", "t2"])), analyse(repoRecords("b/two", ["t1", "t2"], over))];
    return () => deriveSetup(repos, pool(repos).comparison);
  };
  assert.throws(mixed({ modelResolved: "claude-other" }), /one resolved model/);
  assert.throws(mixed({ agentVersion: "2.2.0" }), /one agent version/);
  assert.throws(mixed({ settings: { budgetUsd: 3, timeoutMs: 1_800_000, sandbox: "docker", headRev: "" } }), /runs used 2 different settings/);
});

test("setup derivation throws when the pooled comparison warns", () => {
  const rs = repoRecords("a/one", ["t1", "t2"]).map((r) => ({ ...r, contextFiles: r.contextFiles.map((c) => ({ ...c, path: "AGENTS.md" })) }));
  const repos = [analyse(rs)];
  assert.throws(() => deriveSetup(repos, pool(repos).comparison), /pooled comparison warns: the arms differ only in AGENTS\.md/);
});

test("table and findings are generated from the data", () => {
  const repos = two();
  const pooled = pool(repos);
  const table = renderTable(repos, pooled);
  assert.match(table, /runs \(infra failures excluded\)/);
  assert.match(table, /cost ratio per run, with ÷ without \(95% CI\)/);
  assert.match(table, /covers only these 6 tasks/);
  assert.match(table, /weighted toward expensive tasks/);
  const text = findings(repos, pooled.comparison);
  assert.match(text, /1\.50x/);
  assert.match(text, /Every run reports a cost|Every repo's interval is above 1\.0x/);
  assert.match(text, /paired permutation p of/);
  assert.doesNotMatch(text, /[–—]/);
});

test("timeouts without cost are counted in the notes", () => {
  const rs = repoRecords("a/one", ["t1", "t2", "t3"]);
  rs[0] = { ...rs[0], kind: "timeout", resolved: false, usage: { ...rs[0].usage, costUsd: null } };
  const repos = [analyse(rs)];
  assert.match(renderTable(repos, pool(repos)), /1 of 18 runs report no cost \(1 timed out\)/);
});

test("README splice needs all marker pairs and is stable", () => {
  const readme = "a\n<!-- headline:start -->\nold\n<!-- headline:end -->\n<!-- results:start -->\nold\n<!-- results:end -->\nb\n<!-- findings:start -->\nold\n<!-- findings:end -->\nc\n";
  const once = spliceReadme(readme, "T", "F", "H");
  assert.equal(once, "a\n<!-- headline:start -->\n\nH\n\n<!-- headline:end -->\n<!-- results:start -->\n\nT\n\n<!-- results:end -->\nb\n<!-- findings:start -->\n\nF\n\n<!-- findings:end -->\nc\n");
  assert.equal(spliceReadme(once, "T", "F", "H"), once);
  assert.throws(() => spliceReadme("<!-- results:start -->\n<!-- results:end -->", "T", "F", "H"), /headline:start/);
  assert.throws(() => spliceReadme(readme.replace("<!-- results:start -->", ""), "T", "F", "H"), /results:start/);
  assert.throws(() => spliceReadme(readme.replace("<!-- headline:start -->", ""), "T", "F", "H"), /headline:start/);
});

test("README splice leaves out findings when the README has no findings markers", () => {
  const readme = "a\n<!-- headline:start -->\nold\n<!-- headline:end -->\n<!-- results:start -->\nold\n<!-- results:end -->\nb\n";
  const out = spliceReadme(readme, "T", "F", "H");
  assert.equal(out, "a\n<!-- headline:start -->\n\nH\n\n<!-- headline:end -->\n<!-- results:start -->\n\nT\n\n<!-- results:end -->\nb\n");
  assert.ok(!out.includes("findings"));
  assert.throws(() => spliceReadme(readme.replace("<!-- results:end -->", ""), "T", "F", "H"), /results:start/);
  assert.throws(() => spliceReadme(`${readme}<!-- findings:start -->`, "T", "F", "H"), /findings:start/);
});

test("the README block is a compact table with a bold pooled row and the closing line", () => {
  const repos = two();
  const pooled = pool(repos);
  const setup = deriveSetup(repos, pooled.comparison);
  const lines = renderCompact(repos, pooled, setup).split("\n");
  assert.equal(lines[0], "Claude Code 2.1.0 with claude-test-1, 3 runs per task and arm, capped at $2 and 30 minutes per run, in a Docker sandbox whose network reaches only the model API.");
  assert.equal(lines[2], "| repo | tasks | solved without | solved with | difference | p | cost per run, with ÷ without |");
  const rows = lines.filter((l) => l.startsWith("| ")).slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| \[a\/one\]\(https:\/\/github\.com\/a\/one\) \| 3 \| /);
  assert.match(rows[2], /^\| \*\*all 2 repos\*\* \| 6 \| /);
  assert.match(rows[2], /\| \+\d+\.\d pts \| \d\.\d\d \| \d\.\d\dx \(\d\.\d\dx to \d\.\d\dx\) \|$/);
  for (const r of rows) assert.equal(r.split("|").length, 9);
  assert.equal(lines[lines.length - 1], RESULTS_CLOSING);
  assert.ok(!/[–—]/.test(lines.join("\n")));
});

test("RESULTS.md keeps the merge dates, notes and findings that the README block drops", () => {
  const repos = two().map((r) => ({ ...r, merged: ["2026-01-01", "2026-02-01"] as [string, string] }));
  const pooled = pool(repos);
  const text = renderResults(repos, pooled, deriveSetup(repos, pooled.comparison));
  assert.match(text, /The tasks were merged between these dates: one 2026-01-01 to 2026-02-01/);
  assert.match(text, /No run failed for infrastructure reasons\./);
  assert.match(text, /Cost ratio is the mean cost per run/);
  assert.match(text, /The pooled row covers only these 6 tasks/);
  assert.match(text, /## Findings\n\nThe pooled success difference/);
});

test("headline words the result by significance and handles a cost interval that includes 1.0x", () => {
  const repos = two();
  const pooled = pool(repos).comparison;
  const setup = deriveSetup(repos, pooled);
  const quiet = headline(repos, { ...pooled, pValue: 0.67 }, setup);
  assert.match(quiet, /^Across 6 tasks from 2 repos \(36 runs, /);
  assert.match(quiet, /did not measurably change how often tasks were solved \([+-]\d+\.\d points, 95% CI .+, p = 0\.67\)/);
  assert.match(quiet, /, and each run cost 1\.50x as much with them \(95% CI \d\.\d\dx to \d\.\d\dx\)\.$/);
  const loud = headline(repos, { ...pooled, pValue: 0.012, successDiff: { estimate: 0.08, low: 0.02, high: 0.14 } }, setup);
  assert.match(loud, /tasks were solved more often with the context files \(\+8\.0 points, 95% CI \+2\.0 to \+14\.0, p = 0\.01\)/);
  assert.doesNotMatch(loud, /did not measurably/);
  const lower = headline(repos, { ...pooled, pValue: 0.01, successDiff: { estimate: -0.08, low: -0.14, high: -0.02 } }, setup);
  assert.match(lower, /solved less often with the context files \(-8\.0 points/);
  const spans = headline(repos, { ...pooled, pValue: 0.03, successDiff: { estimate: 0.02, low: -0.01, high: 0.05 } }, setup);
  assert.match(spans, /the difference in how often tasks were solved with the context files was \+2\.0 points/);
  assert.doesNotMatch(spans, /more often|less often|did not measurably/);
  const zero = headline(repos, { ...pooled, pValue: 0.01, successDiff: { estimate: 0, low: -0.03, high: 0.03 } }, setup);
  assert.doesNotMatch(zero, /more often|less often/);
  const crossing = headline(repos, { ...pooled, costRatio: { estimate: 1.02, low: 0.95, high: 1.1 } }, setup);
  assert.match(crossing, /1\.02x as much with them \(95% CI 0\.95x to 1\.10x, which includes 1\.0x\)/);
  const noCost = headline(repos, { ...pooled, costRatio: null }, setup);
  assert.doesNotMatch(noCost, /each run cost/);
  assert.match(noCost, /\)\.$/);
  assert.doesNotMatch(quiet + loud + crossing + noCost, /[–—]/);
});

test("axis always shows the anchor and stays within the cap", () => {
  const a = axis([0.05, 0.1], 0, [-1, 1], [0.05, 0.1, 0.2]);
  assert.ok(a.lo < 0 && a.ticks.includes(0));
  const c = axis([1.2, 9], 1, [0.5, 4], [0.5, 1]);
  assert.equal(c.hi, 4);
  assert.ok(c.ticks.includes(1));
});

test("chart escapes text, uses a real minus, and marks clamped values", () => {
  const repos = [analyse(repoRecords("a/one", ["t1", "t2", "t3"])), analyse(repoRecords("b/<two>&", ["t1", "t2", "t3"]))];
  const pooled = pool(repos);
  const items = chartItems(repos, pooled);
  items[0].c = { ...items[0].c, successDiff: { estimate: -0.2, low: -5, high: 0.1 }, costRatio: { estimate: Number.NaN, low: Number.NaN, high: Number.NaN } };
  const svg = chart(items, "model<x>");
  assert.match(svg, /<title id="t">/);
  assert.match(svg, /<desc id="d">/);
  assert.match(svg, /&lt;two&gt;&amp;/);
  assert.match(svg, /model&lt;x&gt;/);
  assert.match(svg, /−/);
  assert.match(svg, /<path d="M/, "an open arrow for the clamped interval");
  assert.doesNotMatch(svg, /NaN|Infinity/);
});

test("a retried infrastructure failure raises no warning; a residual one makes summarize throw", () => {
  const rs = repoRecords("a/one", ["t1", "t2", "t3"]);
  const failed = (arm: string, rep: number): RunRecord => ({ ...rs.find((r) => r.task === "t1" && r.arm === arm && r.rep === rep)!, kind: "infra", resolved: false });
  // a retry has the same key as the failure it replaces and comes later in the file
  const retried = compareArms([failed("none", 0), failed("none", 1), failed("repo", 2), ...rs], "none", "repo");
  assert.equal(retried.excludedInfra, 0);
  assert.deepEqual(retried.warnings, []);
  const residual = [failed("none", 0), ...rs.filter((r) => !(r.task === "t1" && r.arm === "none" && r.rep === 0))];
  const repos = [analyse(residual)];
  assert.equal(repos[0].comparison.excludedInfra, 1);
  assert.throws(() => deriveSetup(repos, pool(repos).comparison), /never run again/);
});

test("censoring note reports the pooled range and names repos with missing costs", () => {
  const a = repoRecords("a/one", ["t1", "t2", "t3"]);
  a[1] = { ...a[1], kind: "timeout", resolved: false, usage: { ...a[1].usage, costUsd: null as never } };
  const b = repoRecords("b/two", ["t1", "t2", "t3"]);
  b[0] = { ...b[0], kind: "timeout", resolved: false, usage: { ...b[0].usage, costUsd: null as never } };
  const repos = [analyse(a), analyse(b)];
  const table = renderTable(repos, pool(repos));
  assert.match(table, /pooled ratio would lie between \d\.\d\dx and \d\.\d\dx/);
  assert.match(table, /one \d\.\d\dx to \d\.\d\dx, two \d\.\d\dx to \d\.\d\dx/);
  const text = findings(repos, pool(repos).comparison);
  assert.match(text, /In one the 1 run without cost data/);
  assert.match(text, /In two the 1 run without cost data/);
  assert.match(text, /Pooled, the ratio would lie between/);
});

test("findings say when an interval includes 1.0x and which way missing costs lean", () => {
  const same = repoRecords("a/one", ["t1", "t2", "t3"]).map((r) => ({ ...r, usage: { ...r.usage, costUsd: 0.2 } }));
  same[0] = { ...same[0], kind: "timeout", resolved: false, usage: { ...same[0].usage, costUsd: null as never } };
  const repos = [analyse(same)];
  const text = findings(repos, pool(repos).comparison);
  assert.match(text, /The interval of a\/one includes 1\.0x/);
  assert.match(text, /all of them are in the arm without context files, so the ratio is likely an overestimate/);
  const treated = repoRecords("a/one", ["t1", "t2", "t3"]);
  treated[1] = { ...treated[1], kind: "timeout", resolved: false, usage: { ...treated[1].usage, costUsd: null as never } };
  const t2 = [analyse(treated)];
  assert.match(findings(t2, pool(t2).comparison), /likely an underestimate/);
});

test("the committed README, RESULTS.md and chart are what bench/data produces", () => {
  const root = join(import.meta.dirname, "..");
  const out = build(root);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), out.readme);
  assert.equal(readFileSync(join(root, "bench", "RESULTS.md"), "utf8"), out.results);
  assert.equal(readFileSync(join(root, "bench", "results.svg"), "utf8"), out.svg);
});
