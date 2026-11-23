import { type ChildProcess, fork } from "node:child_process";
import type { PlanItem } from "./pipeline/plan.ts";
import type { WorkSource } from "./pipeline/run.ts";

// the coordinator hands out runs over IPC, so no run is given out twice
// each worker has its own sandbox and relay

export const WORKER_ENV = "CTXLIFT_WORKER";

type ToWorker = { t: "item"; key: string } | { t: "end" };
// `done` follows a run's record being saved, so a worker that stops right after isn't counted as having lost it
type FromWorker = { t: "ready" } | { t: "next" } | { t: "done"; key: string };

export function isWorker(): boolean {
  return process.env[WORKER_ENV] !== undefined && typeof process.send === "function";
}

export function reportReady(): void {
  send({ t: "ready" });
}

// a lost coordinator counts as no more work
export function coordinatorSource(byKey: Map<string, PlanItem>): WorkSource {
  return {
    next: () =>
      new Promise<PlanItem | null>((resolve, reject) => {
        const done = () => {
          process.off("message", onMessage);
          process.off("disconnect", onDisconnect);
        };
        const onMessage = (m: ToWorker) => {
          done();
          if (m.t === "end") return resolve(null);
          const item = byKey.get(m.key);
          if (item) resolve(item);
          else reject(new Error(`the coordinator sent a run this worker doesn't know: ${m.key}`));
        };
        const onDisconnect = () => {
          done();
          resolve(null);
        };
        process.on("message", onMessage);
        process.on("disconnect", onDisconnect);
        if (!send({ t: "next" })) onDisconnect();
      }),
    done: (item) => {
      send({ t: "done", key: item.key });
    },
  };
}

// an open IPC channel keeps the process alive
export function leaveCoordinator(): void {
  if (process.connected) process.disconnect();
}

function send(m: FromWorker): boolean {
  if (!process.send || !process.connected) return false;
  // a coordinator that is gone shows up as a disconnect; the failed send itself needs no handling
  process.send(m, (e: Error | null) => void e);
  return true;
}

export interface WorkerPoolOptions {
  workers: number;
  keys: string[];
  script: string;
  args: string[];
  log: (m: string) => void;
  shouldStop: () => boolean;
  // SIGINT and SIGTERM mean stop after the current step, SIGHUP means quit now
  listen: (onSignal: (s: "SIGINT" | "SIGTERM" | "SIGHUP") => void) => () => void;
  onQuit?: (pid: number) => void;
}

export interface WorkerPoolResult {
  notRun: number;
  failed: number;
}

// workers start one after another so they don't build the image or create shared Docker resources at once
// each leads its own process group; signals go to the group because a worker blocked in a synchronous call only sees them once its container stops
export async function runWorkers(o: WorkerPoolOptions): Promise<WorkerPoolResult> {
  const queue = [...o.keys];
  const current = new Map<ChildProcess, string>();
  const live = new Set<ChildProcess>();
  const exits: Promise<void>[] = [];
  let stopRequested = false;
  let failed = 0;
  let lost = 0;
  const stopping = () => stopRequested || o.shouldStop();

  const unsubscribe = o.listen((signal) => {
    stopRequested = true;
    // SIGTERM reaches the group as SIGINT: "finish the current step" for the worker, a stop for its containers
    const sig = signal === "SIGHUP" ? "SIGHUP" : "SIGINT";
    for (const c of live) {
      signalGroup(c, sig);
      if (signal === "SIGHUP" && c.pid !== undefined) o.onQuit?.(c.pid);
    }
  });

  const start = (n: number) =>
    new Promise<void>((resolveStarted) => {
      const child = fork(o.script, o.args, { env: { ...process.env, [WORKER_ENV]: String(n) }, stdio: ["ignore", "inherit", "inherit", "ipc"], detached: true });
      live.add(child);
      let resolveExit = () => {};
      exits.push(new Promise<void>((r) => (resolveExit = r)));
      let started = false;
      const markStarted = () => {
        if (!started) {
          started = true;
          resolveStarted();
        }
      };
      let ended = false;
      const end = (why: string | null) => {
        if (ended) return;
        ended = true;
        live.delete(child);
        if (current.has(child)) lost++;
        current.delete(child);
        if (why !== null) {
          failed++;
          if (!stopping()) o.log(`worker ${n} stopped (${why}); no new runs will start`);
          stopRequested = true;
        }
        markStarted();
        resolveExit();
      };
      child.on("message", (m: FromWorker) => {
        if (m.t === "ready") return markStarted();
        if (m.t === "done") {
          if (current.get(child) === m.key) current.delete(child);
          return;
        }
        // an exit can be handled before this message: a worker that is gone gets nothing
        if (!live.has(child) || !child.connected) return;
        current.delete(child);
        const key = stopping() ? undefined : queue.shift();
        if (key !== undefined) current.set(child, key);
        const reply: ToWorker = key === undefined ? { t: "end" } : { t: "item", key };
        // a failed send means the worker is going away; its exit accounts for the run
        child.send(reply, (e) => void e);
      });
      child.on("exit", (code, signal) => end(code === 0 ? null : (signal ?? `exit code ${code}`)));
      // a worker that could not be started emits only "error"
      child.on("error", (e) => {
        if (child.pid === undefined) end(`could not start: ${e.message}`);
      });
    });

  try {
    for (let n = 1; n <= o.workers && !stopping() && queue.length > 0; n++) await start(n);
    await Promise.all(exits);
  } finally {
    unsubscribe();
  }
  return { notRun: queue.length + lost, failed };
}

function signalGroup(c: ChildProcess, sig: NodeJS.Signals): void {
  if (c.pid === undefined) return;
  try {
    process.kill(-c.pid, sig);
  } catch {
    // the group is gone already
  }
}
