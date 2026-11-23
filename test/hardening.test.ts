import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readRegularFile } from "../src/fsutil.ts";
import { classifyPytestExit, reconcile } from "../src/runners/pytest.ts";
import { containerArgs } from "../src/sandbox/docker.ts";

const root = mkdtempSync(join(tmpdir(), "ctxlift-hardening-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("readRegularFile refuses symlinks, directories and oversized files", () => {
  writeFileSync(join(root, "ok.xml"), "<x/>");
  writeFileSync(join(root, "secret"), "token");
  symlinkSync(join(root, "secret"), join(root, "link.xml"));
  mkdirSync(join(root, "dir.xml"));
  assert.equal(readRegularFile(join(root, "ok.xml"), 100)?.toString(), "<x/>");
  assert.equal(readRegularFile(join(root, "link.xml"), 100), null, "a report swapped for a symlink is not read");
  assert.equal(readRegularFile(join(root, "dir.xml"), 100), null);
  assert.equal(readRegularFile(join(root, "ok.xml"), 2), null, "size cap");
  assert.equal(readRegularFile(join(root, "missing.xml"), 100), null);
});

test("an interrupted or signalled test run is infra, not a verdict on the code", () => {
  assert.equal(classifyPytestExit(130, true, false), "infra");
  assert.equal(classifyPytestExit(137, true, false), "infra");
  assert.equal(classifyPytestExit(null, true, false), "infra");
});

test("a report that disagrees with the exit code counts every test as failed", () => {
  const all = new Map<string, "pass" | "fail">([["a", "pass"], ["b", "pass"]]);
  assert.deepEqual([...reconcile(all, 1).values()], ["fail", "fail"], "exit 1 but no failure reported: forged or broken report");
  assert.deepEqual([...reconcile(all, 0).values()], ["pass", "pass"]);
  const mixed = new Map<string, "pass" | "fail">([["a", "pass"], ["b", "fail"]]);
  assert.deepEqual([...reconcile(mixed, 1).values()], ["pass", "fail"]);
});

test("containers are hardened and labelled", () => {
  const args = containerArgs(
    { network: "none", cwd: "/tmp/ws", env: { A: "1" }, cmd: ["pytest"], timeoutMs: 1 },
    { name: "n", image: "img", user: "501:20", owner: "42", cpus: 2 },
  );
  const has = (...xs: string[]) => args.join(" ").includes(xs.join(" "));
  assert.ok(has("--network", "none"));
  assert.ok(has("--cap-drop", "ALL"));
  assert.ok(has("--security-opt", "no-new-privileges"));
  assert.ok(has("--user", "501:20"));
  assert.ok(has("--cpus", "2"));
  assert.ok(has("--label", "ctxlift.owner=42"));
  assert.ok(has("-v", "/tmp/ws:/workspace"));
  assert.ok(args.includes("--pids-limit") && args.includes("--memory") && args.includes("--init"));
  assert.ok(!args.some((a) => a.includes("docker.sock")), "no docker socket");
  assert.deepEqual(args.slice(-2), ["img", "pytest"]);
});
