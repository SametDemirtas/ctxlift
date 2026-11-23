import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runWorkers } from "../src/workers.ts";

const script = fileURLToPath(new URL("./fixtures/fake-worker.ts", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);

async function pool(workers: number, mode = "") {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-workers-"));
  dirs.push(dir);
  const out = join(dir, "done.txt");
  const logs: string[] = [];
  const r = await runWorkers({ workers, keys, script, args: [out, mode], log: (m) => logs.push(m), shouldStop: () => false, listen: () => () => {} });
  let lines: string[] = [];
  try {
    lines = readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
  } catch {}
  return { r, logs, done: lines.map((l) => l.split(" ")[1]), by: new Set(lines.map((l) => l.split(" ")[0])) };
}

test("every run is handed out exactly once", async () => {
  const { r, done, by } = await pool(3);
  assert.deepEqual(r, { notRun: 0, failed: 0 });
  assert.deepEqual([...done].sort(), [...keys].sort());
  assert.ok(by.size >= 1);
});

test("a worker that dies mid-run stops new runs, and its lost run and the rest count as not run", async () => {
  const { r, done, logs } = await pool(2, "crash");
  assert.equal(r.failed, 1);
  assert.equal(new Set(done).size, done.length, "nothing ran twice");
  assert.equal(r.notRun, keys.length - done.length);
  assert.ok(r.notRun >= 1);
  assert.ok(logs.some((l) => l.startsWith("worker 1 stopped")));
});

test("a worker that fails to start keeps the later ones from starting", async () => {
  const { r, by } = await pool(3, "fail-before-ready");
  assert.equal(r.failed, 1);
  assert.deepEqual([...by], ["1"]);
});

test("a forwarded Ctrl-C reaches a worker that is blocked in a child process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-workers-"));
  dirs.push(dir);
  const out = join(dir, "done.txt");
  let send: (s: "SIGINT" | "SIGTERM" | "SIGHUP") => void = () => {};
  const t0 = Date.now();
  const pool = runWorkers({ workers: 1, keys, script, args: [out, "block"], log: () => {}, shouldStop: () => false, listen: (f) => ((send = f), () => {}) });
  const deadline = Date.now() + 10_000;
  while (!existsSync(`${out}.started`)) {
    assert.ok(Date.now() < deadline, "the worker never started its child");
    await new Promise((r) => setTimeout(r, 20));
  }
  send("SIGINT");
  const r = await pool;
  assert.ok(Date.now() - t0 < 10_000, "the worker stopped long before its 30 s child would have");
  assert.equal(r.failed, 1);
  assert.equal(r.notRun, keys.length);
});

test("nothing starts when a stop was requested before the pool began", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-workers-"));
  dirs.push(dir);
  const r = await runWorkers({ workers: 2, keys, script, args: [join(dir, "x"), ""], log: () => {}, shouldStop: () => true, listen: () => () => {} });
  assert.deepEqual(r, { notRun: keys.length, failed: 0 });
});
