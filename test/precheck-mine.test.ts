import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ARMS } from "../src/arms.ts";
import { execOk } from "../src/exec.ts";
import { Git } from "../src/git.ts";
import { selectRunnable } from "../src/pipeline/precheck.ts";
import type { PullRequestSource } from "../src/tasks/github.ts";
import { mineTasks } from "../src/tasks/mine.ts";
import type { PullRequest, ValidTask } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "ctxlift-precheck-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function repo() {
  const dir = join(root, "repo");
  mkdirSync(dir);
  const g = (...a: string[]) => execOk("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a]).trim();
  const w = (p: string, s: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  g("init", "-q");
  w("src/a.py", "A = 1\n");
  g("add", "-A");
  g("commit", "-qm", "no context yet");
  const noContext = g("rev-parse", "HEAD");
  w("AGENTS.md", "Use pytest.\n");
  g("add", "-A");
  g("commit", "-qm", "context");
  const withContext = g("rev-parse", "HEAD");
  w("AGENTS.md", "Use pytest. src/a.py holds the constants.\n");
  g("commit", "-qam", "today");
  return { source: new Git(dir), noContext, withContext, head: g("rev-parse", "HEAD") };
}

const task = (id: string, baseSha: string, extra: Partial<ValidTask> = {}) =>
  ({ id, baseSha, allFiles: ["src/a.py"], srcFiles: ["src/a.py"], ...extra }) as unknown as ValidTask;

test("precheck skips tasks where arms show the same context, and head tasks its files could leak", () => {
  const { source, noContext, withContext, head } = repo();
  const ctx = { source, headRev: head };
  const r = selectRunnable([task("early", noContext), task("late", withContext)], [ARMS.repo, ARMS.none], ctx);
  assert.deepEqual(r.run.map((t) => t.id), ["late"]);
  assert.match(r.skipped[0].reason, /same context/);

  const h = selectRunnable([task("late", withContext), task("other", withContext, { srcFiles: ["src/b.py"], allFiles: ["src/b.py"] })], [ARMS.head, ARMS.none], ctx);
  assert.deepEqual(h.run.map((t) => t.id), ["other"]);
  assert.match(h.skipped[0].reason, /mention src\/a\.py/);
  const own = selectRunnable([task("own", withContext, { allFiles: ["src/a.py", "AGENTS.md"], srcFiles: ["src/x.py"] })], [ARMS.head, ARMS.none], ctx);
  assert.match(own.skipped[0].reason, /edited a context file/);
});

test("mineTasks keeps selectable PRs, records renamed paths, and stops at max", () => {
  const pr = (n: number, files: PullRequest["files"]): PullRequest => ({
    number: n, title: `PR ${n}`, body: "Fix it.\n\n## Testing\nran test_x", mergedAt: "2026-09-01T00:00:00Z", mergeSha: "m".repeat(40),
    commits: 1, changedFiles: files.length, files,
  });
  const f = (filename: string, status = "modified", previousFilename?: string) => ({ filename, status, additions: 5, deletions: 0, ...(previousFilename ? { previousFilename } : {}) });
  const source: PullRequestSource = {
    defaultBranch: () => "main",
    *mergedPulls() {
      yield pr(1, [f("src/a.py"), f("tests/test_a.py")]);
      yield pr(2, [f("docs/x.md")]);
      yield pr(3, [f("src/new.py", "renamed", "src/old.py"), f("tests/test_new.py", "renamed", "tests/test_old.py")]);
      yield pr(4, [f("src/c.py"), f("tests/test_c.py")]);
    },
  };
  const skipped: string[] = [];
  const tasks = mineTasks(source, { repo: "o/r", since: "2026-01-01", max: 2, log: (m) => skipped.push(m) });
  assert.deepEqual(tasks.map((t) => t.id), ["r-1", "r-3"]);
  assert.deepEqual(tasks[1].allFiles.sort(), ["src/new.py", "src/old.py", "tests/test_new.py", "tests/test_old.py"]);
  assert.deepEqual(tasks[1].removedTestFiles, ["tests/test_old.py"]);
  assert.ok(!tasks[0].prompt.includes("test_x"), "testing section stripped");
  assert.ok(skipped.some((m) => m.includes("#2")));
});

test("head leak check matches paths, file names and module paths, not generic names", async () => {
  const { mentionsFile } = await import("../src/arms.ts");
  assert.ok(mentionsFile("Constants live in src/pkg/consts.py.", "src/pkg/consts.py"));
  assert.ok(mentionsFile("Edit consts.py for limits.", "src/pkg/consts.py"));
  assert.ok(mentionsFile("See pkg.consts for limits.", "src/pkg/consts.py"));
  assert.ok(mentionsFile("Edit pkg/consts.py to add X", "src/pkg/consts.py"), "a shorter path suffix counts");
  assert.ok(!mentionsFile("See myconsts.py.", "src/pkg/consts.py"));
  assert.ok(!mentionsFile("Each package has an __init__.py.", "src/pkg/__init__.py"), "generic names alone don't count");
  assert.ok(mentionsFile("Look at src/pkg/__init__.py.", "src/pkg/__init__.py"));
});
