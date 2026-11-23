import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TestEnvironment } from "../src/environment.ts";
import { execOk } from "../src/exec.ts";
import { Git } from "../src/git.ts";
import { HostLauncher } from "../src/launcher.ts";
import { gradeAgentWork } from "../src/pipeline/evaluate.ts";
import { validateTasks } from "../src/pipeline/validate.ts";
import type { FileOutcome, TestRunner } from "../src/runners/types.ts";
import type { Task } from "../src/types.ts";

class FileRunner implements TestRunner {
  readonly spec = { name: "fake", command: ["fake"] };
  isTarget(p: string) {
    return /test_[^/]*\.py$/.test(p);
  }
  checkEnvironment(): string | null {
    return null;
  }
  setupCommand() {
    return null;
  }
  cachePaths() {
    return [];
  }
  runFile(cwd: string, file: string): FileOutcome {
    if (!existsSync(join(cwd, file))) return { kind: "collection_error", detail: "missing" };
    const a = readFileSync(join(cwd, "src/a.py"), "utf8");
    return { kind: "ran", tests: new Map([[`${file}::test_a`, a.includes("A = 2") ? "pass" : "fail"], [`${file}::test_keep`, "pass"]]) };
  }
}

const env: TestEnvironment = { launcher: new HostLauncher(), setup: () => null };
const root = mkdtempSync(join(tmpdir(), "ctxlift-validate-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function repo(name = "repo") {
  const dir = join(root, name);
  mkdirSync(dir);
  const g = (...a: string[]) => execOk("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a]).trim();
  const w = (p: string, s: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  g("init", "-q");
  w("src/a.py", "A = 1\n");
  w("tests/test_a.py", "# old\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  w("src/a.py", "A = 2\n");
  w("tests/test_a.py", "# new\n");
  g("commit", "-qam", "pr");
  return { dir, merge: g("rev-parse", "HEAD") };
}

test("validation keeps a task whose gold change turns a test green, and grading scores agent work through the same path", async () => {
  const { dir, merge } = repo();
  const source = new Git(dir);
  const ctx = { source, env, runner: new FileRunner() };
  const task: Task = {
    id: "r-1", repo: "o/r", pr: 1, title: "make A two", prompt: "p", mergeSha: merge, mergedAt: "", commits: 1,
    allFiles: ["src/a.py", "tests/test_a.py"], srcFiles: ["src/a.py"], testFiles: ["tests/test_a.py"], removedTestFiles: [], srcLines: 1, promptRemovedLines: 0,
  };
  const { valid, dropped } = await validateTasks(ctx, [task], { afterRuns: 2 });
  assert.deepEqual(dropped, {});
  assert.equal(valid.length, 1);
  const v = valid[0];
  assert.deepEqual(v.failToPass, ["tests/test_a.py::test_a"]);
  assert.deepEqual(v.passToPass, ["tests/test_a.py::test_keep"]);
  assert.equal(v.baseSha, source.revParse(`${merge}^1`));

  const agentDir = mkdtempSync(join(root, "agent-"));
  source.exportTree(v.baseSha, agentDir);
  const before = gradeAgentWork(ctx, v, agentDir);
  assert.equal(before.kind === "graded" && before.resolved, false, "untouched code fails");
  writeFileSync(join(agentDir, "src/a.py"), "A = 2\n");
  const g = gradeAgentWork(ctx, v, agentDir);
  assert.equal(g.kind === "graded" && g.resolved, true, "the fix passes");

  const again = await validateTasks(ctx, [task], { afterRuns: 1 }, { valid, dropped: {} });
  assert.equal(again.valid.length, 1, "resume keeps decided tasks without re-running them");
});

test("grading checks the test tool when the tests can't run, and marks an environment failure as such", () => {
  const { dir, merge } = repo("repo2");
  const source = new Git(dir);
  const base = source.revParse(`${merge}^1`) as string;
  const t = { baseSha: base, mergeSha: merge, testFiles: ["tests/test_a.py"], removedTestFiles: [], testTargets: ["tests/test_a.py"], failToPass: ["tests/test_a.py::test_a"], passToPass: [] } as never;
  const agentDir = mkdtempSync(join(root, "agent-env-"));
  source.exportTree(base, agentDir);
  const down = new (class extends FileRunner {
    runFile(): FileOutcome {
      return { kind: "infra", reason: "no report" };
    }
    checkEnvironment(): string | null {
      return "exit 1: unsatisfiable";
    }
  })();
  const g = gradeAgentWork({ source, env, runner: down }, t, agentDir);
  assert.deepEqual(g.kind === "infra" && g.environment, true);
  const up = new (class extends FileRunner {
    runFile(): FileOutcome {
      return { kind: "infra", reason: "no report" };
    }
  })();
  const h = gradeAgentWork({ source, env, runner: up }, t, agentDir);
  assert.equal(h.kind === "infra" && h.environment, undefined, "a tool that starts leaves the decision to the base check");
});
