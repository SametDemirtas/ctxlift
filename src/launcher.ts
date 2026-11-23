import { exec, type ExecResult } from "./exec.ts";

export interface LaunchOptions {
  cwd: string;
  env: Record<string, string>;
  // host only; sandboxes start from a clean environment
  dropEnv?: (name: string) => boolean;
  timeoutMs: number;
}

export interface Launcher {
  readonly kind: string;
  readonly isolated: boolean;
  run(cmd: string, args: string[], o: LaunchOptions): ExecResult;
}

export class HostLauncher implements Launcher {
  readonly kind = "host";
  readonly isolated = false;

  run(cmd: string, args: string[], o: LaunchOptions): ExecResult {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!o.dropEnv?.(k)) env[k] = v;
    return exec(cmd, args, { cwd: o.cwd, env: { ...env, ...o.env }, timeoutMs: o.timeoutMs });
  }
}
