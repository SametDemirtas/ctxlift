#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_NAMES, agentEntry } from "./agents/index.ts";
import { ARM_IDS, type ArmContext, ARMS, parseArms } from "./arms.ts";
import { isoDate, nonNegativeInt, positiveInt, positiveNumber, splitCommand } from "./args.ts";
import { DockerEnvironment, HostEnvironment, type TestEnvironment } from "./environment.ts";
import { HostLauncher } from "./launcher.ts";
import { readJson, writeJson } from "./fsutil.ts";
import { Git } from "./git.ts";
import { defaultDeps } from "./pipeline/deps.ts";
import type { EvalContext } from "./pipeline/evaluate.ts";
import { buildPlan, type PlanItem } from "./pipeline/plan.ts";
import { selectRunnable } from "./pipeline/precheck.ts";
import { executeItems, executePlan, INTERRUPTED, RunAborted } from "./pipeline/run.ts";
import { resumeMismatch, validateTasks } from "./pipeline/validate.ts";
import { formatComparison } from "./report.ts";
import { ResultsStore } from "./results/store.ts";
import { createRunner, RUNNER_NAMES } from "./runners/index.ts";
import { DockerSandbox } from "./sandbox/docker.ts";
import { compareArms } from "./stats.ts";
import { GhCliSource } from "./tasks/github.ts";
import { coordinatorSource, isWorker, leaveCoordinator, reportReady, runWorkers, WORKER_ENV } from "./workers.ts";
import { loadTasks, loadValidTasks } from "./tasks/load.ts";
import { mineTasks } from "./tasks/mine.ts";
import type { RunnerSpec } from "./types.ts";

const USAGE = `ctxlift: do AGENTS.md / CLAUDE.md files help a coding agent on your repo?

Usage:
  ctxlift mine <owner/repo> [--since YYYY-MM-DD (default: 120 days ago)] [--max 40] [--out tasks/<owner>__<repo>.json] [--quiet]
  ctxlift validate <tasks.json> --clone <dir> [--sandbox docker|none] [--runner pytest] [--test-cmd "uv run --frozen pytest"]
                    [--setup-cmd "uv sync --frozen"] [--after-runs 3] [--test-timeout-min 15] [--out <tasks>.valid.json]
  ctxlift run <tasks.valid.json> --clone <dir> [--arms repo,none] [--reps 3] [--agent claude] [--model <name>]
               [--budget 2] [--timeout-min 30] [--test-timeout-min 15] [--sandbox docker|none] [--token-file <file>]
               [--config-dir <dir>] [--seed 1] [--limit N] [--workers 1] [--out results/runs.jsonl]
  ctxlift report <runs.jsonl> [--baseline none] [--treatment repo] [--repo R] [--agent A] [--model M]
  ctxlift --version

Arms:
${ARM_IDS.map((id) => `  ${id.padEnd(5)} ${ARMS[id].description}`).join("\n")}
Runners: ${RUNNER_NAMES.join(", ")}    Agents: ${AGENT_NAMES.join(", ")}

With --sandbox docker (the default) agents and tests run in containers; with none they run on this machine.
validate and run continue where they stopped when run again with the same --out.
--workers N runs N agents at a time, each in its own sandbox; a worker that finishes early takes the next run.
`;

const logPrefix = process.env[WORKER_ENV] ? `[w${process.env[WORKER_ENV]}] ` : "";
const log = (m: string) => console.log(`${logPrefix}${m}`);
const warn = (m: string) => console.error(`${logPrefix}${m}`);

// a second Ctrl-C exits at once; the running child gets the first one too, so its run is discarded and redone next time
let interrupted = false;
const shouldStop = () => interrupted;
const cleanups: Array<() => void> = [];
function quitNow(): never {
  for (const c of cleanups) c();
  process.exit(130);
}
function onInterrupt(): void {
  if (interrupted) quitNow();
  interrupted = true;
  // a worker's signals come from its coordinator, which already told the user
  if (!isWorker()) warn("interrupted: finishing the current step, then stopping (Ctrl-C again to quit now)");
}
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
process.on("SIGHUP", quitNow);
// a worker whose coordinator is gone stops after its current step and drops that run, so a new run of the command doesn't pay for it twice
if (isWorker()) process.on("disconnect", () => (interrupted = true));

function version(): string {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version : "unknown";
}

function requireDir(flag: string, v: string | undefined): string {
  if (!v) throw new Error(`--${flag} is required`);
  const p = resolve(v);
  if (!existsSync(p)) throw new Error(`--${flag} ${p} does not exist`);
  return p;
}

function requireFile(what: string, v: string | undefined): string {
  if (!v) throw new Error(`missing ${what}`);
  if (!existsSync(v)) throw new Error(`${v} does not exist`);
  return v;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function siblingPath(input: string, suffix: string): string {
  return input.endsWith(".json") ? input.replace(/\.json$/, suffix) : `${input}${suffix}`;
}

function environment(mode: string | undefined, testTimeoutMs: number, credentials: Record<string, string> | null) {
  const m = mode ?? "docker";
  if (m === "none") {
    log("warning: --sandbox none runs agents and their code on this machine; leakage can only be detected");
    return { env: new HostEnvironment(testTimeoutMs) as TestEnvironment, sandbox: null };
  }
  if (m !== "docker") throw new Error(`--sandbox must be docker or none, got "${m}"`);
  const sandbox = new DockerSandbox({ credentials: credentials ?? {} });
  log("preparing the docker sandbox (the first time builds an image, which takes a few minutes)");
  // registered first: a signal can stop ensure() after it started the relay, which holds the credentials
  cleanups.push(() => sandbox.cleanup());
  sandbox.ensure({ relay: credentials !== null });
  return { env: new DockerEnvironment(sandbox, testTimeoutMs) as TestEnvironment, sandbox };
}

// caches may hold built copies of the merged fix
function forbiddenPaths(clone: string, runnerCaches: string[]): string[] {
  const paths = [clone, realpathSync(clone), ...runnerCaches];
  if (clone.startsWith(homedir())) paths.push(`~${clone.slice(homedir().length)}`);
  return [...new Set(paths)];
}

function contextFactory(source: Git, env: TestEnvironment, testTimeoutMs: number): (spec: RunnerSpec) => EvalContext {
  const cache = new Map<string, EvalContext>();
  return (spec) => {
    const key = JSON.stringify(spec);
    let ctx = cache.get(key);
    if (!ctx) {
      ctx = { source, env, runner: createRunner(spec, { timeoutMs: testTimeoutMs, launcher: env.launcher }) };
      cache.set(key, ctx);
    }
    return ctx;
  };
}

function mine(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { since: { type: "string" }, max: { type: "string" }, out: { type: "string" }, quiet: { type: "boolean" } },
  });
  const repo = positionals[0];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("usage: ctxlift mine <owner/repo>");
  const tasks = mineTasks(new GhCliSource(), {
    repo,
    since: isoDate("since", values.since, new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10)),
    max: positiveInt("max", values.max, 40),
    log: values.quiet ? undefined : log,
  });
  const out = values.out ?? `tasks/${repo.replace("/", "__")}.json`;
  writeJson(out, tasks);
  log(`${tasks.length} candidate tasks -> ${out}`);
}

async function validate(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      clone: { type: "string" },
      sandbox: { type: "string" },
      runner: { type: "string" },
      "test-cmd": { type: "string" },
      "setup-cmd": { type: "string" },
      "after-runs": { type: "string" },
      "test-timeout-min": { type: "string" },
      out: { type: "string" },
    },
  });
  const input = requireFile("tasks file (ctxlift validate <tasks.json>)", positionals[0]);
  const tasks = loadTasks(input);
  const out = values.out ?? siblingPath(input, ".valid.json");
  const droppedOut = siblingPath(out, ".dropped.json");
  if (resolve(out) === resolve(input)) throw new Error("--out must differ from the input file");
  const testTimeoutMs = positiveInt("test-timeout-min", values["test-timeout-min"], 15) * 60_000;
  const source = new Git(requireDir("clone", values.clone));
  const { env, sandbox } = environment(values.sandbox, testTimeoutMs, null);
  const requested: RunnerSpec = {
    name: values.runner ?? "pytest",
    command: values["test-cmd"] ? splitCommand(values["test-cmd"]) : [],
    ...(values["setup-cmd"] ? { setup: splitCommand(values["setup-cmd"]) } : {}),
  };
  const ctx = contextFactory(source, env, testTimeoutMs)(requested);
  const previous = {
    valid: existsSync(out) ? loadValidTasks(out) : [],
    dropped: existsSync(droppedOut) ? readJson<Record<string, string>>(droppedOut) : {},
  };
  // resuming with other commands would mix tasks validated two ways, and keep tasks dropped under the old ones dropped
  const specOut = siblingPath(out, ".runner.json");
  const earlier = existsSync(specOut) ? readJson<RunnerSpec>(specOut) : previous.valid[0]?.runner;
  const mismatch = resumeMismatch(previous, earlier, ctx.runner.spec);
  if (mismatch) throw new Error(`${out} was validated ${mismatch}; use another --out, or delete ${out}, ${droppedOut} and ${specOut}`);
  writeJson(specOut, ctx.runner.spec);
  const save = (v: unknown, d: unknown) => {
    writeJson(out, v);
    writeJson(droppedOut, d);
  };
  try {
    const { valid, dropped } = await validateTasks(ctx, tasks, { afterRuns: positiveInt("after-runs", values["after-runs"], 3), log, onProgress: save, shouldStop }, previous);
    save(valid, dropped);
    log(`${valid.length}/${tasks.length} valid -> ${out} (reasons for dropped tasks: ${droppedOut}; commands used: ${specOut})`);
    if (interrupted) throw new RunAborted("validation was interrupted; run the same command to finish it");
  } finally {
    sandbox?.cleanup();
  }
}

async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      clone: { type: "string" },
      arms: { type: "string" },
      reps: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      budget: { type: "string" },
      "timeout-min": { type: "string" },
      "test-timeout-min": { type: "string" },
      "config-dir": { type: "string" },
      sandbox: { type: "string" },
      "token-file": { type: "string" },
      seed: { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      workers: { type: "string" },
    },
  });
  const worker = isWorker();
  const workers = worker ? 1 : positiveInt("workers", values.workers, 1);
  const all = loadValidTasks(requireFile("validated tasks file (ctxlift run <tasks.valid.json>)", positionals[0]));
  if (all.length === 0) throw new Error("no validated tasks to run");
  const clone = requireDir("clone", values.clone);
  const source = new Git(clone);
  const arms = parseArms(values.arms ?? "repo,none");
  const armContext: ArmContext = { source, headRev: source.revParse("HEAD") ?? "HEAD" };
  // everything that can fail cheaply comes before the sandbox starts (the relay holds credentials)
  const { run: runnable, skipped } = selectRunnable(all, arms, armContext);
  if (!worker) for (const s of skipped) log(`skip ${s.task.id}: ${s.reason}`);
  const tasks = runnable.slice(0, positiveInt("limit", values.limit, runnable.length || 1));
  if (tasks.length === 0) throw new Error("no task left to run");
  const docker = (values.sandbox ?? "docker") === "docker";
  const agentName = values.agent ?? "claude";
  const entry = agentEntry(agentName);
  const settings = {
    budgetUsd: positiveNumber("budget", values.budget, 2),
    timeoutMs: positiveInt("timeout-min", values["timeout-min"], 30) * 60_000,
    sandbox: docker ? "docker" : "host",
    // only the head arm depends on the clone's commit; for other arms a git pull shouldn't restart everything
    headRev: arms.some((a) => a.id === "head") ? armContext.headRev : "",
  };
  const model = values.model ?? entry.defaultModel;
  const plan = buildPlan(tasks, arms, positiveInt("reps", values.reps, 3), nonNegativeInt("seed", values.seed, 1), agentName, model, settings);
  const store = new ResultsStore(values.out ?? "results/runs.jsonl");
  if (docker && values["config-dir"] && !worker) log("note: --config-dir is ignored in the sandbox, which starts from an empty Claude profile");
  if (workers > 1) {
    // fail here rather than in every worker
    if (docker) entry.loadCredentials(values["token-file"]);
    return coordinate(plan, store, workers, docker);
  }

  const testTimeoutMs = positiveInt("test-timeout-min", values["test-timeout-min"], 15) * 60_000;
  const { env, sandbox } = environment(values.sandbox, testTimeoutMs, docker ? entry.loadCredentials(values["token-file"]) : null);
  const contextFor = contextFactory(source, env, testTimeoutMs);
  const caches = [...new Map(tasks.map((t) => [JSON.stringify(t.runner), t.runner])).values()].flatMap((s) => contextFor(s).runner.cachePaths());
  const agent = entry.create({
    launcher: sandbox ? sandbox.agentLauncher(entry.sandboxEnv) : new HostLauncher(),
    configDir: values["config-dir"] ? resolve(values["config-dir"]) : undefined,
    forbiddenPaths: forbiddenPaths(clone, caches),
  });
  const deps = defaultDeps(source, agent, store, (t) => contextFor(t.runner), armContext);
  const opts = { maxConsecutiveInfra: 3, log, shouldStop };
  try {
    if (worker) {
      reportReady();
      await executeItems(deps, coordinatorSource(new Map(plan.map((p) => [p.key, p]))), opts);
    } else {
      await executePlan(deps, plan, opts);
    }
  } finally {
    sandbox?.cleanup();
    if (worker) leaveCoordinator();
  }
}

async function coordinate(plan: PlanItem[], store: ResultsStore, requested: number, docker: boolean): Promise<void> {
  const done = store.completedKeys();
  const todo = plan.filter((p) => !done.has(p.key)).map((p) => p.key);
  const workers = Math.min(requested, Math.max(todo.length, 1));
  log(`${plan.length} runs planned, ${plan.length - todo.length} already done, ${todo.length} to go, on ${plural(workers, "worker")}`);
  if (todo.length === 0) return;
  if (interrupted) throw new RunAborted(INTERRUPTED);
  const r = await runWorkers({
    workers,
    keys: todo,
    script: process.argv[1],
    args: process.argv.slice(2),
    log,
    shouldStop,
    // quitting at once: a worker blocked on a container only sees its signal once that container stops
    onQuit: docker ? (pid) => DockerSandbox.removeContainersOf(pid) : undefined,
    listen: (onSignal) => {
      const int = () => onSignal("SIGINT");
      const term = () => onSignal("SIGTERM");
      const quit = () => onSignal("SIGHUP");
      process.on("SIGINT", int);
      process.on("SIGTERM", term);
      cleanups.push(quit);
      return () => {
        process.off("SIGINT", int);
        process.off("SIGTERM", term);
        const i = cleanups.indexOf(quit);
        if (i >= 0) cleanups.splice(i, 1);
      };
    },
  });
  if (interrupted) throw new RunAborted(INTERRUPTED);
  // runs with no record at all; an infrastructure failure is recorded and redone next time, as without --workers
  const recorded = new Set(store.load().map((r) => r.key));
  const left = todo.filter((k) => !recorded.has(k)).length;
  if (r.failed > 0 || left > 0) {
    const failed = r.failed > 0 ? ` and ${plural(r.failed, "worker")} stopped with an error` : "";
    throw new RunAborted(`${plural(left, "run")} not done${failed}; run the same command again to do them`);
  }
}

function report(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      treatment: { type: "string" },
      repo: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
    },
  });
  const records = new ResultsStore(requireFile("results file (ctxlift report <runs.jsonl>)", positionals[0]))
    .load()
    .filter((r) => (!values.repo || r.repo === values.repo) && (!values.agent || r.agent === values.agent) && (!values.model || r.model === values.model));
  log(formatComparison(compareArms(records, values.baseline ?? "none", values.treatment ?? "repo")));
}

const COMMANDS: Record<string, (argv: string[]) => void | Promise<void>> = { mine, validate, run, report };

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    log(version());
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    log(USAGE);
    return 0;
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    return 2;
  }
  try {
    await handler(rest);
    return 0;
  } catch (e) {
    warn(e instanceof RunAborted ? e.message : `error: ${(e as Error).message}`);
    return 1;
  } finally {
    for (const c of cleanups.splice(0)) c();
  }
}

process.exitCode = await main(process.argv.slice(2));
process.exit();
