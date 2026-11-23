import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Agent, AgentRunInput, AgentRunResult } from "../src/agents/types.ts";
import { EMPTY_USAGE } from "../src/agents/types.ts";
import { ARMS } from "../src/arms.ts";
import type { Grade } from "../src/pipeline/grade.ts";
import { buildPlan } from "../src/pipeline/plan.ts";
import { executePlan, RunAborted, type RunDeps, type RunOptions } from "../src/pipeline/run.ts";
import { ResultsStore } from "../src/results/store.ts";
import type { Git } from "../src/git.ts";
import type { RunKind, ValidTask } from "../src/types.ts";
import type { WorkspaceHandle } from "../src/workspace.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const task = (id: string) => ({ id, repo: "o/r", baseSha: "b".repeat(40), prompt: `do ${id}`, failToPass: ["t"], runner: { name: "fake", command: [] } }) as unknown as ValidTask;

class FakeAgent implements Agent {
  readonly name = "fake";
  readonly script: Array<Partial<AgentRunResult>>;
  calls: AgentRunInput[] = [];
  constructor(script: Array<Partial<AgentRunResult>>) {
    this.script = script;
  }
  version() {
    return "0";
  }
  preflight() {}
  run(i: AgentRunInput): AgentRunResult {
    this.calls.push(i);
    const s = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    return { kind: "completed" as RunKind, fatal: false, subtype: "success", message: null, usage: { ...EMPTY_USAGE, costUsd: 0.1 }, audit: [], suspect: [], limit: null, modelResolved: "model-x", ...s };
  }
}

function fakeWorkspace(): WorkspaceHandle {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-fake-ws-"));
  dirs.push(dir);
  return { dir, contextFiles: () => [], dispose: () => {} };
}

// `grades` are returned in order (agent grading, its retry, then oracle checks); the last one repeats
function setup(agent: FakeAgent, grades: Grade[], oracleRuns = true) {
  const storeDir = mkdtempSync(join(tmpdir(), "ctxlift-run-test-"));
  dirs.push(storeDir);
  const store = new ResultsStore(join(storeDir, "runs.jsonl"));
  let i = 0;
  const deps: RunDeps = {
    agent,
    store,
    armContext: { source: {} as Git, headRev: "HEAD" },
    createWorkspace: (_task: ValidTask, prepare: (dir: string) => void) => {
      const ws = fakeWorkspace();
      prepare(ws.dir);
      return ws;
    },
    prepareWorkspace: () => null,
    grade: () => grades[Math.min(i++, grades.length - 1)],
    testsRunOnBase: () => oracleRuns,
  };
  return { deps, store };
}

const opts: RunOptions = { maxConsecutiveInfra: 2 };
const S = { budgetUsd: 1, timeoutMs: 1000, sandbox: "docker", headRev: "h" };
const pass: Grade = { kind: "graded", resolved: true, f2pPassed: 1, f2pTotal: 1, p2pBroken: 0, note: null };

test("runs every item once, records results, and resume skips what is done", async () => {
  const agent = new FakeAgent([{}]);
  const { deps, store } = setup(agent, [pass]);
  const plan = buildPlan([task("a"), task("b")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S);
  const out = await executePlan(deps, plan, opts);
  assert.equal(out.length, 4);
  assert.ok(out.every((r) => r.kind === "completed" && r.resolved && r.repo === "o/r" && r.usage.costUsd === 0.1));
  assert.equal((await executePlan(deps, plan, opts)).length, 0, "nothing left to do");
  assert.equal(agent.calls.length, 4);
  assert.equal(store.load().length, 4);
});

test("contaminated runs are recorded as such", async () => {
  const agent = new FakeAgent([{ audit: ["WebFetch: https://github.com/x"] }]);
  const { deps } = setup(agent, [pass]);
  const [r] = await executePlan(deps, buildPlan([task("a")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S).slice(0, 1), opts);
  assert.equal(r.contaminated, true);
  assert.deepEqual(r.audit, ["WebFetch: https://github.com/x"]);
});

test("a grading failure is retried, then blamed on the agent if the tests run on base, on infra if they don't", async () => {
  const broken: Grade = { kind: "infra", reason: "exit 4: ImportError in conftest" };
  const plan = (a: FakeAgent) => buildPlan([task("a")], [ARMS.repo, ARMS.none], 1, 1, a.name, "m", S).slice(0, 1);

  const a1 = new FakeAgent([{}]);
  const [r1] = await executePlan(setup(a1, [broken, broken], true).deps, plan(a1), opts);
  assert.equal(r1.kind, "completed");
  assert.equal(r1.resolved, false);
  assert.match(r1.gradingNote ?? "", /ImportError/);
  assert.equal(r1.modelResolved, "model-x");
  assert.equal(r1.settings.budgetUsd, 1);

  const a2 = new FakeAgent([{}]);
  const [r2] = await executePlan(setup(a2, [broken, broken], false).deps, plan(a2), opts);
  assert.equal(r2.kind, "infra");
  assert.match(r2.error ?? "", /grading/);

  const a3 = new FakeAgent([{}]);
  const [r3] = await executePlan(setup(a3, [broken, pass]).deps, plan(a3), opts);
  assert.equal(r3.resolved, true, "a transient failure that passes on retry is graded normally");

  const toolDown: Grade = { kind: "infra", reason: "uv: unsatisfiable", environment: true };
  const a4 = new FakeAgent([{}]);
  const [r4] = await executePlan(setup(a4, [toolDown, toolDown], true).deps, plan(a4), opts);
  assert.equal(r4.kind, "infra", "a test tool that can't start in the graded workspace is never the agent's failure");
});

test("a failed dependency setup is infra and the agent never starts", async () => {
  const agent = new FakeAgent([{}]);
  const { deps } = setup(agent, [pass]);
  deps.prepareWorkspace = () => "setup (uv sync --frozen) failed: no network";
  const [r] = await executePlan(deps, buildPlan([task("a")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S).slice(0, 1), opts);
  assert.equal(r.kind, "infra");
  assert.match(r.error ?? "", /uv sync/);
  assert.equal(agent.calls.length, 0);
});

test("consecutive infra failures stop the run", async () => {
  const agent = new FakeAgent([{ kind: "infra", message: "API Error: 500" }]);
  const { deps, store } = setup(agent, [pass]);
  const plan = buildPlan([task("a"), task("b"), task("c")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S);
  await assert.rejects(executePlan(deps, plan, opts), (e: unknown) => e instanceof RunAborted && /2 infrastructure failures/.test(e.message));
  assert.equal(store.load().length, 2);
  assert.equal(store.completedKeys().size, 0, "infra runs are retried on resume");
});

test("a fatal agent error is recorded and stops immediately", async () => {
  const agent = new FakeAgent([{ kind: "infra", fatal: true, message: "Not logged in" }]);
  const { deps, store } = setup(agent, [pass]);
  const plan = buildPlan([task("a"), task("b")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S);
  await assert.rejects(executePlan(deps, plan, opts), /Not logged in/);
  assert.equal(agent.calls.length, 1);
  assert.equal(store.load().length, 1);
  assert.equal(store.load()[0].error, "Not logged in");
});

test("an exception while preparing a run becomes an infra record, not a crash", async () => {
  const agent = new FakeAgent([{}]);
  const { deps } = setup(agent, [pass]);
  deps.createWorkspace = () => {
    throw new Error("disk full");
  };
  const [r] = await executePlan(deps, buildPlan([task("a")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S).slice(0, 1), opts);
  assert.equal(r.kind, "infra");
  assert.equal(r.error, "disk full");
  assert.equal(agent.calls.length, 0);
});

test("a run that finishes while an interrupt is pending is discarded and redone later", async () => {
  const agent = new FakeAgent([{}]);
  const { deps, store } = setup(agent, [pass]);
  let stop = false;
  agent.run = (i) => {
    stop = true; // Ctrl-C arrives while the agent runs
    return FakeAgent.prototype.run.call(agent, i);
  };
  const plan = buildPlan([task("a"), task("b")], [ARMS.repo, ARMS.none], 1, 1, agent.name, "m", S);
  await assert.rejects(executePlan(deps, plan, { ...opts, shouldStop: () => stop }), /interrupted/);
  assert.equal(store.load().length, 0, "nothing recorded for the interrupted run");
});

