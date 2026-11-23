import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ARMS, parseArms, removeContextFiles } from "../src/arms.ts";
import { execOk } from "../src/exec.ts";
import { Git } from "../src/git.ts";
import { isResetBeforeGrading } from "../src/pipeline/evaluate.ts";
import { Workspace } from "../src/workspace.ts";

let root = "";
let src: Git;
let baseSha = "";
let laterSha = "";

const write = (dir: string, p: string, s: string) => {
  mkdirSync(join(dir, p, ".."), { recursive: true });
  writeFileSync(join(dir, p), s);
};
const g = (dir: string, ...a: string[]) => execOk("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a]).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), "ctxlift-ws-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q");
  write(repo, "AGENTS.md", "rules");
  write(repo, "CLAUDE.md", "@AGENTS.md");
  write(repo, "pkg/sub/AGENTS.md", "nested rules");
  write(repo, ".claude/commands/x.md", "cmd");
  write(repo, "src/a.py", "A = 1\n");
  write(repo, "tests/test_a.py", "def test_a(): pass\n");
  write(repo, "tests/conftest.py", "# base conftest\n");
  write(repo, "pyproject.toml", "[tool.pytest]\n");
  symlinkSync("AGENTS.md", join(repo, ".cursorrules"));
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "base");
  baseSha = g(repo, "rev-parse", "HEAD");
  write(repo, "src/a.py", "A = 2  # the solution\n");
  write(repo, "AGENTS.md", "rules v2");
  g(repo, "commit", "-qam", "later");
  laterSha = g(repo, "rev-parse", "HEAD");
  src = new Git(repo);
});

after(() => rmSync(root, { recursive: true, force: true }));

const armCtx = () => ({ source: src, headRev: laterSha });

test("arms: parse validates ids", () => {
  assert.deepEqual(parseArms("repo, none").map((a) => a.id), ["repo", "none"]);
  assert.deepEqual(parseArms("none,bare").map((a) => a.id), ["none", "bare"]);
  assert.throws(() => parseArms("repo,nope"), /unknown arm "nope"/);
  assert.throws(() => parseArms("repo,repo"), /duplicate/);
  assert.throws(() => parseArms("repo"), /at least two/);
});

test("arms: none removes context files at any depth and symlinks to them, nothing else", () => {
  const dir = mkdtempSync(join(root, "export-"));
  src.exportTree(baseSha, dir);
  const removed = removeContextFiles(dir);
  assert.deepEqual(removed, [".cursorrules", "AGENTS.md", "CLAUDE.md", "pkg/sub/AGENTS.md"]);
  assert.ok(existsSync(join(dir, "src/a.py")));
  assert.ok(existsSync(join(dir, ".claude/commands/x.md")), ".claude/ is reported, not removed");
  const bare = mkdtempSync(join(root, "export-"));
  src.exportTree(baseSha, bare);
  ARMS.bare.prepare(bare, armCtx());
  assert.ok(!existsSync(join(bare, ".claude/commands/x.md")), "bare also removes .claude/");
  assert.ok(!existsSync(join(bare, "AGENTS.md")));
});

test("workspace: fresh repo at the base commit, no history or remote, arm applied before commit", () => {
  const ws = Workspace.create(src, baseSha, (d) => ARMS.none.prepare(d, armCtx()));
  try {
    assert.equal(readFileSync(join(ws.dir, "src/a.py"), "utf8"), "A = 1\n");
    assert.equal(g(ws.dir, "rev-list", "--count", "HEAD"), "1");
    assert.equal(g(ws.dir, "remote"), "");
    assert.equal(g(ws.dir, "log", "--all", "--format=%s"), "base");
    assert.equal(g(ws.dir, "status", "--porcelain"), "", "removal is not visible as a change");
    assert.deepEqual(ws.contextFiles().map((c) => c.path), [".claude/commands/x.md"]);
  } finally {
    ws.dispose();
  }
  assert.ok(!src.has("deadbeef"));
  assert.ok(src.has(laterSha));
});

test("workspace: repo arm reports context files with hashes", () => {
  const ws = Workspace.create(src, baseSha, (d) => ARMS.repo.prepare(d, armCtx()));
  try {
    const ctx = ws.contextFiles();
    assert.deepEqual(ctx.map((c) => c.path), [".claude/commands/x.md", "AGENTS.md", "CLAUDE.md", "pkg/sub/AGENTS.md"]);
    assert.equal(ctx.find((c) => c.path === "AGENTS.md")?.bytes, 5);
    assert.match(ctx[0].sha256, /^[0-9a-f]{64}$/);
  } finally {
    ws.dispose();
  }
});

test("workspace: copyChangesFrom carries the agent's code changes and nothing else", () => {
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  try {
    write(agent.dir, "src/a.py", "A = 2\n");
    write(agent.dir, "src/new.py", "B = 1\n");
    chmodSync(join(agent.dir, "src/new.py"), 0o755);
    write(agent.dir, "tests/test_a.py", "def test_a(): assert True  # weakened\n");
    write(agent.dir, "pyproject.toml", "[tool.pytest]\naddopts='-k nothing'\n");
    write(agent.dir, ".venv/lib/site.py", "patched");
    rmSync(join(agent.dir, "AGENTS.md"));
    const r = fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.deepEqual(r.written.sort(), ["src/a.py", "src/new.py"]);
    assert.deepEqual(r.deleted, []);
    assert.equal(readFileSync(join(fresh.dir, "src/a.py"), "utf8"), "A = 2\n");
    assert.ok((lstatSync(join(fresh.dir, "src/new.py")).mode & 0o111) !== 0, "executable bit kept");
    assert.equal(readFileSync(join(fresh.dir, "tests/test_a.py"), "utf8"), "def test_a(): pass\n", "tests stay at base");
    assert.equal(readFileSync(join(fresh.dir, "pyproject.toml"), "utf8"), "[tool.pytest]\n", "config stays at base");
    assert.ok(existsSync(join(fresh.dir, "AGENTS.md")), "context files stay at base, so every arm is graded alike");
    assert.ok(!existsSync(join(fresh.dir, ".venv")), "environments are never copied");
    rmSync(join(agent.dir, "src/a.py"));
    assert.deepEqual(fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p)).deleted, ["src/a.py"]);
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});

test("workspace: symlinks the agent plants are never followed, so nothing outside the workspace is read or written", () => {
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  const victim = mkdtempSync(join(root, "victim-"));
  try {
    writeFileSync(join(victim, "secret.py"), "TOKEN = 'x'\n");
    writeFileSync(join(victim, "test_a.py"), "precious\n");
    symlinkSync(join(victim, "secret.py"), join(agent.dir, "src/leak.py"));
    rmSync(join(agent.dir, "tests"), { recursive: true });
    symlinkSync(victim, join(agent.dir, "tests"));
    symlinkSync(victim, join(agent.dir, "src/escape"));
    const r = fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.deepEqual(r.skippedLinks.sort(), [".cursorrules", "src/escape", "src/leak.py", "tests"]);
    assert.ok(!existsSync(join(fresh.dir, "src/leak.py")));
    fresh.overlayFrom(laterSha, ["tests/test_a.py"]);
    assert.equal(readFileSync(join(victim, "test_a.py"), "utf8"), "precious\n", "hidden tests are written into the fresh workspace only");
    assert.ok(lstatSync(join(fresh.dir, "tests")).isDirectory());
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});

test("arms: head replaces context files with the versions at headRev", () => {
  const ws = Workspace.create(src, baseSha, (d) => ARMS.head.prepare(d, armCtx()));
  try {
    assert.equal(readFileSync(join(ws.dir, "AGENTS.md"), "utf8"), "rules v2", "today's AGENTS.md on the old code");
    assert.equal(readFileSync(join(ws.dir, "src/a.py"), "utf8"), "A = 1\n", "code stays at the base commit");
  } finally {
    ws.dispose();
  }
});

test("workspace: a symlinked context file is recorded with its target", () => {
  const ws = Workspace.create(src, baseSha, () => {});
  try {
    rmSync(join(ws.dir, "CLAUDE.md"));
    symlinkSync("docs/guide.md", join(ws.dir, "CLAUDE.md"));
    assert.ok(ws.contextFiles().some((c) => c.path === "CLAUDE.md" && c.sha256 === "symlink:docs/guide.md"));
  } finally {
    ws.dispose();
  }
});

test("git: fileAt, listBlobs and revParse read other commits", () => {
  assert.equal(src.fileAt(laterSha, "src/a.py")?.toString(), "A = 2  # the solution\n");
  assert.equal(src.fileAt(laterSha, "nope.py"), null);
  assert.ok(src.listBlobs(baseSha).has("tests/test_a.py"));
  assert.deepEqual(src.changedFiles(baseSha, laterSha), ["AGENTS.md", "src/a.py"]);
  assert.equal(src.revParse(`${laterSha}^1`), baseSha);
  assert.equal(src.revParse("nope"), null);
  const blobs = src.listBlobs(baseSha);
  assert.equal(blobs.get(".cursorrules")?.mode, "120000", "symlinks are listed with their mode");
  assert.equal(blobs.get("src/a.py")?.mode, "100644");
});

test("git: exportTree ignores export-ignore attributes, so the export matches a checkout", () => {
  const repo = join(root, "attrs");
  mkdirSync(repo);
  g(repo, "init", "-q");
  write(repo, ".gitattributes", "tests/fixtures export-ignore\n");
  write(repo, "tests/fixtures/data.txt", "fixture");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "c");
  const out = mkdtempSync(join(root, "export-"));
  new Git(repo).exportTree("HEAD", out);
  assert.equal(readFileSync(join(out, "tests/fixtures/data.txt"), "utf8"), "fixture");
});

test("workspace: deletions never go through a symlinked parent", () => {
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  const victim = mkdtempSync(join(root, "victim2-"));
  try {
    writeFileSync(join(victim, "a.py"), "keep me\n");
    rmSync(join(agent.dir, "src/a.py"));
    rmSync(join(fresh.dir, "src"), { recursive: true });
    symlinkSync(victim, join(fresh.dir, "src"));
    fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.equal(readFileSync(join(victim, "a.py"), "utf8"), "keep me\n", "a file outside the workspace survives");
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});

test("workspace: case variants can't slip agent files past the reset, and case-only renames survive", () => {
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  try {
    write(agent.dir, "Tests/helpers.py", "evil = True\n");
    write(agent.dir, "PyProject.toml", "[tool.pytest]\naddopts='-p evil'\n");
    rmSync(join(agent.dir, "src/a.py"));
    write(agent.dir, "src/A.py", "A = 3\n");
    const r = fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.ok(!r.written.some((p) => /tests\/|pyproject/i.test(p)), r.written.join(","));
    assert.equal(readFileSync(join(fresh.dir, "pyproject.toml"), "utf8"), "[tool.pytest]\n");
    assert.deepEqual(r.written, ["src/A.py"]);
    assert.equal(readFileSync(join(fresh.dir, "src/A.py"), "utf8"), "A = 3\n", "the renamed file exists with the agent's content");
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});

test("workspace: compatibility variants of reset names are caught too (macOS folds them)", async () => {
  const { foldName } = await import("../src/workspace.ts");
  assert.equal(foldName("tests/confteſt.py"), "tests/conftest.py");
  assert.equal(foldName("Conftest.py"), "conftest.py");
  assert.equal(foldName("pyproject.toml"), "pyproject.toml");
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  try {
    write(agent.dir, "confteſt.py", "planted = True\n");
    const r = fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.ok(!r.written.includes("confteſt.py"), r.written.join(","));
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});

test("workspace: case variants of skipped directories are skipped too (no writes into .git or .venv)", () => {
  const agent = Workspace.create(src, baseSha, () => {});
  const fresh = Workspace.create(src, baseSha, () => {});
  try {
    write(agent.dir, ".Venv/lib/evil.pth", "import os\n");
    write(agent.dir, "__PYCACHE__/x.pyc", "x");
    const r = fresh.copyChangesFrom(agent.dir, (p) => !isResetBeforeGrading(p));
    assert.deepEqual(r.written, []);
  } finally {
    agent.dispose();
    fresh.dispose();
  }
});
