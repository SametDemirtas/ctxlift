import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { exec, lastLines } from "../exec.ts";
import { readRegularFile } from "../fsutil.ts";
import type { Launcher } from "../launcher.ts";
import type { RunnerSpec } from "../types.ts";
import { parseJUnit } from "./junit.ts";
import type { FileOutcome, TestRunner } from "./types.ts";

const DEFAULT_COMMAND = ["uv", "run", "--frozen", "pytest"];
const TEST_MODULE = /(^|\/)test_[^/]*\.py$|_test\.py$/;
// ignored when copying the agent's changes
const REPORT_DIR = ".ctxlift";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 2 * 60_000;

// pytest exit codes: 0 all passed, 1 some failed, 2 interrupted (collection errors), 3 internal error, 4 usage error, 5 nothing collected; 128 and above is a signal (e.g. Ctrl-C) and says nothing about the code under test
export function classifyPytestExit(code: number | null, reportExists: boolean, timedOut: boolean): "ran" | "collection_error" | "infra" {
  if (timedOut || !reportExists || code === null || code >= 128) return "infra";
  if (code === 0 || code === 1) return "ran";
  if (code === 2 || code === 5) return "collection_error";
  return "infra";
}

// exit 1 with no failure in the report means the report can't be trusted (e.g. code under test rewrote it), so every test counts as failed
export function reconcile(tests: Map<string, "pass" | "fail">, code: number | null): Map<string, "pass" | "fail"> {
  if (code === 1 && ![...tests.values()].includes("fail")) return new Map([...tests.keys()].map((k) => [k, "fail"]));
  return tests;
}

export class PytestRunner implements TestRunner {
  readonly spec: RunnerSpec;
  private readonly timeoutMs: number;
  private readonly launcher: Launcher;

  constructor(launcher: Launcher, command: string[] = DEFAULT_COMMAND, timeoutMs = 15 * 60_000, setup?: string[]) {
    if (command.length === 0) throw new Error("pytest command is empty");
    if (setup !== undefined && setup.length === 0) throw new Error("setup command is empty");
    this.spec = setup ? { name: "pytest", command, setup } : { name: "pytest", command };
    this.timeoutMs = timeoutMs;
    this.launcher = launcher;
  }

  isTarget(path: string): boolean {
    return TEST_MODULE.test(path);
  }

  setupCommand(): string[] | null {
    if (this.spec.setup) return this.spec.setup;
    return this.usesUv ? ["uv", "sync", "--frozen"] : null;
  }

  cachePaths(): string[] {
    if (!this.usesUv) return [];
    const r = exec("uv", ["cache", "dir"], { timeoutMs: 30_000 });
    return r.code === 0 && r.stdout.trim() ? [r.stdout.trim()] : [];
  }

  private get usesUv(): boolean {
    return this.spec.command[0] === "uv";
  }

  // with uv, tests never sync the environment the setup step built: `uv run` can decide the editable project is stale (its check includes the source directory's timestamp and inode, which Docker on macOS doesn't always keep)
  // and then rebuild it with no network. A custom setup command must therefore install everything the tests need, pytest plugins included
  private testEnv(): Record<string, string> {
    return this.usesUv ? { UV_NO_SYNC: "1" } : {};
  }

  // conftest, ini options and plugin autoloading are off so no project code is imported, also on older pytest; a timeout proves nothing
  checkEnvironment(cwd: string): string | null {
    const [bin, ...pre] = this.spec.command;
    const env = { ...this.testEnv(), PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "" };
    const r = this.launcher.run(bin, [...pre, "--version", "--noconftest", "-o", "addopts="], { cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (r.code === 0 || r.timedOut) return null;
    return r.error ?? `exit ${r.code ?? r.signal}: ${lastLines(r.stdout + r.stderr, 5, 400)}`;
  }

  runFile(cwd: string, file: string): FileOutcome {
    // a fresh name per run: some shared file systems (e.g. Docker on macOS) can briefly show a deleted file to the next container
    const relative = `${REPORT_DIR}/report-${randomBytes(6).toString("hex")}.xml`;
    const report = join(cwd, relative);
    try {
      const [bin, ...pre] = this.spec.command;
      const r = this.launcher.run(bin, [...pre, file, "-p", "no:cacheprovider", `--junitxml=${relative}`], { cwd, env: this.testEnv(), timeoutMs: this.timeoutMs });
      if (r.error && !r.timedOut) return { kind: "infra", reason: r.error };
      // the report is written by the process under test, so it is read without following links and with a size cap
      const xml = readRegularFile(report, MAX_REPORT_BYTES);
      const kind = classifyPytestExit(r.code ?? (r.signal ? 128 : null), xml !== null, r.timedOut);
      const tail = lastLines(r.stdout + r.stderr, 5, 400);
      if (kind === "infra") return { kind, reason: r.timedOut ? "timeout" : `exit ${r.code ?? r.signal}: ${tail}` };
      if (kind === "collection_error") return { kind, detail: `exit ${r.code}: ${tail}` };
      return { kind, tests: reconcile(parseJUnit((xml as Buffer).toString("utf8")), r.code) };
    } finally {
      rmSync(report, { force: true });
    }
  }
}
