import { spawnSync } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  // SIGKILL for clients that forward SIGTERM and wait, like `docker run`
  killSignal?: NodeJS.Signals;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

const MAX_BUFFER = 512 * 1024 * 1024;

function spawn(cmd: string, args: string[], o: ExecOptions, encoding: "utf8" | "buffer") {
  return spawnSync(cmd, args, {
    cwd: o.cwd,
    input: o.input,
    timeout: o.timeoutMs,
    killSignal: o.killSignal,
    env: o.env ?? process.env,
    encoding,
    maxBuffer: MAX_BUFFER,
  });
}

// never through a shell, so arguments are not re-parsed
export function exec(cmd: string, args: string[], o: ExecOptions = {}): ExecResult {
  const r = spawn(cmd, args, o, "utf8");
  const err = r.error as NodeJS.ErrnoException | undefined;
  return {
    code: r.status,
    signal: r.signal,
    stdout: (r.stdout as string | null) ?? "",
    stderr: (r.stderr as string | null) ?? "",
    timedOut: err?.code === "ETIMEDOUT",
    error: err ? `${err.code ?? ""} ${err.message}`.trim() : null,
  };
}

export function execOk(cmd: string, args: string[], o: ExecOptions = {}, label = cmd): string {
  const r = exec(cmd, args, o);
  if (r.code !== 0) {
    const why = r.error ?? (r.stderr || r.stdout).trim().slice(0, 400);
    throw new Error(`${label} failed (${r.code ?? r.signal}): ${why}`);
  }
  return r.stdout;
}

export function lastLines(text: string, n: number, maxChars: number): string {
  return text.trim().split("\n").slice(-n).join(" | ").slice(0, maxChars);
}

export function execBuffer(cmd: string, args: string[], o: ExecOptions = {}): Buffer | null {
  const r = spawn(cmd, args, o, "buffer");
  return r.status === 0 ? (r.stdout as Buffer) : null;
}
