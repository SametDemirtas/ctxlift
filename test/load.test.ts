import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTasks, loadValidTasks } from "../src/tasks/load.ts";

const sha = "a".repeat(40);
const task = { id: "r-1", repo: "o/r", prompt: "p", mergeSha: sha, commits: 1, allFiles: ["a.py"], testFiles: ["tests/test_a.py"], removedTestFiles: [] };
const valid = { ...task, baseSha: sha, runner: { name: "pytest", command: ["pytest"] }, testTargets: ["tests/test_a.py"], failToPass: ["m::t"], passToPass: [] };

test("task files are checked on load with a hint about the missing step", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-load-"));
  try {
    const p = (name: string, data: unknown) => {
      const f = join(dir, name);
      writeFileSync(f, JSON.stringify(data));
      return f;
    };
    assert.equal(loadTasks(p("t.json", [task])).length, 1);
    assert.equal(loadValidTasks(p("v.json", [valid])).length, 1);
    assert.throws(() => loadValidTasks(p("m.json", [task])), /baseSha.*ctxlift validate/);
    assert.throws(() => loadTasks(p("x.json", { tasks: [] })), /not a list/);
    assert.throws(() => loadTasks(p("bad.json", [{ ...task, mergeSha: "short" }])), /mergeSha.*ctxlift mine/);
    assert.throws(() => loadValidTasks(p("e.json", [{ ...valid, failToPass: [] }])), /failToPass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
