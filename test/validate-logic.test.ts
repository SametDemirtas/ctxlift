import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommitGraph, resolveBase } from "../src/pipeline/base.ts";
import { classifyTests, isUsableTask } from "../src/pipeline/classify.ts";
import { resumeMismatch } from "../src/pipeline/validate.ts";
import type { Outcome } from "../src/types.ts";

const m = (o: Record<string, Outcome>) => new Map(Object.entries(o));

test("classify: fail-to-pass, pass-to-pass, flaky, broken", () => {
  const before = m({ a: "fail", b: "pass", c: "pass", d: "pass" });
  const after = [m({ a: "pass", b: "pass", c: "pass", d: "fail", e: "pass" }), m({ a: "pass", b: "pass", c: "fail", d: "fail", e: "pass" })];
  const c = classifyTests([before], after);
  assert.deepEqual(c.failToPass, ["a", "e"], "e is new (missing before) and passes after");
  assert.deepEqual(c.passToPass, ["b"]);
  assert.deepEqual(c.flaky, ["c"]);
  assert.deepEqual(c.brokenAfter, ["d"]);
  assert.equal(isUsableTask(c), false, "a test broken after the merge makes the task unusable");
});

test("classify: usable only with at least one fail-to-pass", () => {
  assert.equal(isUsableTask(classifyTests([m({ a: "pass" })], [m({ a: "pass" })])), false);
  assert.equal(isUsableTask(classifyTests([m({ a: "fail" })], [m({ a: "pass" })])), true);
  assert.throws(() => classifyTests([m({})], []));
  assert.throws(() => classifyTests([], [m({})]));
});

test("classify: a test that fails only sometimes on the base commit is flaky, not fail-to-pass", () => {
  const c = classifyTests([m({ a: "fail", b: "fail" }), m({ a: "pass", b: "fail" })], [m({ a: "pass", b: "pass" })]);
  assert.deepEqual(c.flaky, ["a"]);
  assert.deepEqual(c.failToPass, ["b"]);
});

class FakeGraph implements CommitGraph {
  readonly revs: Record<string, string>;
  readonly diffs: Record<string, string[]>;
  constructor(revs: Record<string, string>, diffs: Record<string, string[]>) {
    this.revs = revs;
    this.diffs = diffs;
  }
  revParse(rev: string) {
    return this.revs[rev] ?? null;
  }
  changedFiles(from: string, to: string) {
    return this.diffs[`${from}..${to}`] ?? [];
  }
}

test("base: squash merge uses the first parent when its diff is exactly the PR", () => {
  const g = new FakeGraph({ "M^1": "P" }, { "P..M": ["src/a.py", "tests/test_a.py"] });
  assert.equal(resolveBase(g, "M", 1, ["tests/test_a.py", "src/a.py"]), "P");
});

test("base: rebase merge walks back by the PR's commit count", () => {
  const g = new FakeGraph({ "M^1": "C2", "M~3": "B" }, { "C2..M": ["src/a.py"], "B..M": ["src/a.py", "src/b.py", "tests/t.py"] });
  assert.equal(resolveBase(g, "M", 3, ["src/a.py", "src/b.py", "tests/t.py"]), "B");
});

test("base: a rebased PR whose last commit touches every file still resolves to the commit before the PR", () => {
  const files = ["src/a.py", "tests/test_a.py"];
  const g = new FakeGraph({ "M^1": "C1", "M~2": "B" }, { "C1..M": files, "B..M": files });
  assert.equal(resolveBase(g, "M", 2, files), "B", "M^1 already contains the PR's first commit");
});

test("base: no candidate matching the PR's files gives null", () => {
  const g = new FakeGraph({ "M^1": "P" }, { "P..M": ["src/a.py", "src/other.py"] });
  assert.equal(resolveBase(g, "M", 1, ["src/a.py"]), null);
  assert.equal(resolveBase(new FakeGraph({}, {}), "M", 1, ["src/a.py"]), null);
});

test("resuming validation needs the same recorded test and setup commands", () => {
  const spec = { name: "pytest", command: ["uv", "run", "pytest"] };
  const withSetup = { ...spec, setup: ["uv", "sync", "--all-extras"] };
  const none = { valid: [], dropped: {} };
  const droppedOnly = { valid: [], dropped: { t1: "test file fails to load on base" } };
  assert.equal(resumeMismatch(none, undefined, withSetup), null);
  assert.equal(resumeMismatch(droppedOnly, spec, spec), null);
  assert.match(resumeMismatch(droppedOnly, undefined, withSetup) ?? "", /weren't recorded/);
  assert.match(resumeMismatch(droppedOnly, spec, withSetup) ?? "", /other test or setup commands/);
});
