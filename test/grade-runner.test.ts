import assert from "node:assert/strict";
import { test } from "node:test";
import { grade } from "../src/pipeline/grade.ts";
import { createRunner, runSuite } from "../src/runners/index.ts";
import { HostLauncher } from "../src/launcher.ts";
import { classifyPytestExit } from "../src/runners/pytest.ts";
import type { FileOutcome, TestRunner } from "../src/runners/types.ts";
import type { ValidTask } from "../src/types.ts";

const task = {
  id: "t-1", failToPass: ["m::a", "m::b"], passToPass: ["m::c"], runner: { name: "pytest", command: ["pytest"] },
} as unknown as ValidTask;

test("grade: resolved only when all fail-to-pass pass and no pass-to-pass breaks", () => {
  const ok = grade(task, { kind: "ok", tests: new Map([["m::a", "pass"], ["m::b", "pass"], ["m::c", "pass"]]), collectionErrors: [] });
  assert.deepEqual(ok, { kind: "graded", resolved: true, f2pPassed: 2, f2pTotal: 2, p2pBroken: 0, note: null });
  const broke = grade(task, { kind: "ok", tests: new Map([["m::a", "pass"], ["m::b", "pass"], ["m::c", "fail"]]), collectionErrors: [] });
  assert.equal(broke.kind === "graded" && broke.resolved, false);
});

test("grade: tests missing because the agent broke imports count as failures, not infra", () => {
  const g = grade(task, { kind: "ok", tests: new Map(), collectionErrors: [{ file: "tests/test_m.py", detail: "ImportError: x" }] });
  assert.deepEqual(g, { kind: "graded", resolved: false, f2pPassed: 0, f2pTotal: 2, p2pBroken: 1, note: "tests/test_m.py failed to load: ImportError: x" });
});

test("grade: a runner that could not run is infra", () => {
  assert.deepEqual(grade(task, { kind: "infra", reason: "uv failed" }), { kind: "infra", reason: "uv failed" });
});

test("pytest exit codes map to ran / collection error / infra", () => {
  assert.equal(classifyPytestExit(0, true, false), "ran");
  assert.equal(classifyPytestExit(1, true, false), "ran");
  assert.equal(classifyPytestExit(2, true, false), "collection_error");
  assert.equal(classifyPytestExit(5, true, false), "collection_error");
  assert.equal(classifyPytestExit(3, true, false), "infra");
  assert.equal(classifyPytestExit(4, true, false), "infra");
  assert.equal(classifyPytestExit(1, false, false), "infra", "no report means the runner never ran");
  assert.equal(classifyPytestExit(0, true, true), "infra", "timeout");
});

class ScriptedRunner implements TestRunner {
  readonly spec = { name: "fake", command: ["fake"] };
  isTarget(): boolean {
    return true;
  }
  cachePaths(): string[] {
    return [];
  }
  checkEnvironment(): string | null {
    return null;
  }
  setupCommand(): string[] | null {
    return null;
  }
  readonly script: Record<string, FileOutcome>;
  constructor(script: Record<string, FileOutcome>) {
    this.script = script;
  }
  runFile(_cwd: string, file: string): FileOutcome {
    return this.script[file];
  }
}

test("runSuite merges files, keeps collection errors per file, and stops on infra", () => {
  const r = new ScriptedRunner({
    a: { kind: "ran", tests: new Map([["x::1", "pass"]]) },
    b: { kind: "collection_error", detail: "ImportError" },
    c: { kind: "infra", reason: "timeout" },
  });
  const ok = runSuite(r, "/", ["a", "b"]);
  assert.equal(ok.kind, "ok");
  assert.deepEqual(ok.kind === "ok" && [...ok.tests], [["x::1", "pass"]]);
  assert.deepEqual(ok.kind === "ok" && ok.collectionErrors, [{ file: "b", detail: "ImportError" }]);
  assert.deepEqual(runSuite(r, "/", ["a", "c"]), { kind: "infra", reason: "c: timeout" });
});

test("pytest runs test modules only, not helpers, conftest or fixtures", () => {
  const r = createRunner({ name: "pytest" }, { launcher: new HostLauncher() });
  for (const p of ["tests/test_a.py", "tests/server/test_b.py", "pkg/a_test.py"]) assert.ok(r.isTarget(p), p);
  for (const p of ["tests/conftest.py", "tests/__init__.py", "tests/helpers.py", "tests/data/x.json", "tests/test_data/x.json"]) assert.ok(!r.isTarget(p), p);
});

test("createRunner keeps the stored command and rejects unknown runners", () => {
  assert.deepEqual(createRunner({ name: "pytest", command: ["python", "-m", "pytest"] }, { launcher: new HostLauncher() }).spec.command, ["python", "-m", "pytest"]);
  assert.deepEqual(createRunner({ name: "pytest" }, { launcher: new HostLauncher() }).spec.command, ["uv", "run", "--frozen", "pytest"]);
  assert.throws(() => createRunner({ name: "nope" }, { launcher: new HostLauncher() }), /unknown test runner/);
});

test("a stored setup command replaces the default install and is kept in the spec", () => {
  const launcher = new HostLauncher();
  const plain = createRunner({ name: "pytest" }, { launcher });
  assert.deepEqual(plain.setupCommand(), ["uv", "sync", "--frozen"]);
  assert.equal(plain.spec.setup, undefined);
  const custom = createRunner({ name: "pytest", setup: ["uv", "sync", "--frozen", "--all-extras"] }, { launcher });
  assert.deepEqual(custom.setupCommand(), ["uv", "sync", "--frozen", "--all-extras"]);
  assert.deepEqual(custom.spec.setup, ["uv", "sync", "--frozen", "--all-extras"]);
  assert.throws(() => createRunner({ name: "pytest", setup: [] }, { launcher }), /setup command is empty/);
});

test("pytest via uv runs tests without syncing the environment again", () => {
  const seen: Record<string, string | undefined>[] = [];
  const launcher = { run: (_b: string, _a: string[], o: { env?: Record<string, string> }) => (seen.push(o.env ?? {}), { code: 4, signal: null, stdout: "", stderr: "", timedOut: false }) };
  const uv = createRunner({ name: "pytest", command: ["uv", "run", "--frozen", "pytest"] }, { launcher } as never);
  uv.runFile("/nonexistent", "tests/test_x.py");
  assert.equal(seen[0].UV_NO_SYNC, "1");
  const plain = createRunner({ name: "pytest", command: ["pytest"] }, { launcher } as never);
  plain.runFile("/nonexistent", "tests/test_x.py");
  assert.equal(seen[1].UV_NO_SYNC, undefined);
});

test("the pytest environment probe loads no project code and treats a timeout as no answer", () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  let result = { code: 1 as number | null, signal: null, stdout: "", stderr: "boom", timedOut: false };
  const launcher = { run: (_b: string, args: string[], o: { env?: Record<string, string> }) => (calls.push({ args, env: o.env ?? {} }), result) };
  const uv = createRunner({ name: "pytest", command: ["uv", "run", "--frozen", "pytest"] }, { launcher } as never);
  assert.match(uv.checkEnvironment("/nonexistent") ?? "", /exit 1/);
  assert.deepEqual(calls[0].args, ["run", "--frozen", "pytest", "--version", "--noconftest", "-o", "addopts="]);
  assert.deepEqual(calls[0].env, { UV_NO_SYNC: "1", PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "" });
  result = { code: null, signal: null, stdout: "", stderr: "", timedOut: true };
  assert.equal(uv.checkEnvironment("/nonexistent"), null);
  result = { code: 0, signal: null, stdout: "pytest 9", stderr: "", timedOut: false };
  assert.equal(uv.checkEnvironment("/nonexistent"), null);
});
