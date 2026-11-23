import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPENDENCY_FILE, isGradingEnvironment, isProductCode, isTestFile } from "../src/tasks/paths.ts";
import { selectPullRequest } from "../src/tasks/select.ts";
import type { PrFile, PullRequest } from "../src/types.ts";

const f = (filename: string, add = 10, status = "modified"): PrFile => ({ filename, status, additions: add, deletions: 0 });
const pr = (files: PrFile[], changedFiles = files.length): PullRequest => ({
  number: 1, title: "t", body: "", mergedAt: "2026-10-01T00:00:00Z", mergeSha: "m", commits: 1, changedFiles, files,
});

test("path classification", () => {
  assert.ok(isTestFile("tests/server/test_x.py"));
  assert.ok(isTestFile("src/foo.test.ts"));
  assert.ok(isTestFile("pkg/conftest.py"));
  assert.ok(!isTestFile("src/mcp/shared/testing/helpers.py"), "testing/ is source, not tests");
  assert.ok(isProductCode("src/mcp/server.py"));
  assert.ok(!isProductCode("docs_src/tutorial001.py"));
  assert.ok(!isProductCode("README.md"));
  assert.ok(isGradingEnvironment("pyproject.toml"));
  assert.ok(isGradingEnvironment("uv.lock"));
  assert.ok(isGradingEnvironment(".pytest.ini"));
  assert.ok(isGradingEnvironment("tests/helpers.py"));
  assert.ok(!isGradingEnvironment("src/a.py"));
  assert.ok(!isTestFile("spec/parser.py"), "spec/ is a source directory name too");
});

test("dependency files are matched by name, not by substring", () => {
  for (const p of ["uv.lock", "poetry.lock", "package.json", "pyproject.toml", "requirements-dev.txt", "pnpm-lock.yaml"]) {
    assert.ok(DEPENDENCY_FILE.test(p), p);
  }
  for (const p of ["src/clock.py", "src/blocking.py", "tests/test_lock.py", "src/lockfile_utils.py"]) {
    assert.ok(!DEPENDENCY_FILE.test(p), p);
  }
});

test("accepts a small PR with product code and tests", () => {
  const r = selectPullRequest(pr([f("src/a.py", 20), f("tests/test_a.py", 30)]));
  assert.deepEqual(r, { ok: true, srcFiles: ["src/a.py"], testFiles: ["tests/test_a.py"], removedTestFiles: [], srcLines: 20 });
});

test("rejects for the right reason", () => {
  const reason = (p: PullRequest) => {
    const r = selectPullRequest(p);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reason(pr([f("src/a.py")])), "no tests");
  assert.equal(reason(pr([f("tests/test_a.py")])), "no product code");
  assert.equal(reason(pr([f("src/a.py"), f("tests/test_a.py"), f("uv.lock")])), "dependency change");
  assert.equal(reason(pr([f("src/a.py"), f("tests/test_a.py"), f("pytest.ini")])), "test configuration change");
  assert.equal(reason(pr([f("src/a.py", 300), f("tests/test_a.py")])), "source change too large");
  assert.equal(reason(pr([f("src/a.py", 1), f("tests/test_a.py")])), "source change too small");
  assert.equal(reason(pr([f("src/a.py"), f("tests/test_a.py")], 150)), "too many files");
  assert.equal(reason(pr([f("src/a.py"), f("tests/test_a.py")], 3)), "too many files", "file list incomplete");
  const many = Array.from({ length: 7 }, (_, i) => f(`src/m${i}.py`, 5));
  assert.equal(reason(pr([...many, f("tests/test_a.py")])), "too many source files");
});

test("removed test files and docs tests don't count as hidden tests", () => {
  const r = selectPullRequest(pr([f("src/a.py"), f("tests/test_old.py", 0, "removed"), f("tests/docs_src/test_t.py")]));
  assert.deepEqual(r, { ok: false, reason: "no tests" });
});

test("helpers and fixtures under tests/ are hidden files; deleted and renamed-away tests are tracked", () => {
  const r = selectPullRequest(
    pr([
      f("src/a.py"),
      f("tests/test_a.py"),
      f("tests/conftest.py"),
      f("tests/data/case.json"),
      f("tests/test_gone.py", 0, "removed"),
      { filename: "tests/test_new_name.py", status: "renamed", additions: 1, deletions: 0, previousFilename: "tests/test_old_name.py" },
    ]),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.testFiles, ["tests/test_a.py", "tests/conftest.py", "tests/data/case.json", "tests/test_new_name.py"]);
  assert.deepEqual(r.removedTestFiles, ["tests/test_gone.py", "tests/test_old_name.py"]);
});
