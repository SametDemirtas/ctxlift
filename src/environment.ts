import type { ExecResult } from "./exec.ts";
import { lastLines } from "./exec.ts";
import { HostLauncher, type Launcher } from "./launcher.ts";
import type { DockerSandbox } from "./sandbox/docker.ts";

export interface TestEnvironment {
  readonly launcher: Launcher;
  setup(dir: string, command: string[] | null): string | null;
}

function setupError(command: string[], r: ExecResult): string | null {
  if (r.code === 0) return null;
  return `setup (${command.join(" ")}) failed: ${r.timedOut ? "timeout" : r.error ?? lastLines(r.stderr || r.stdout, 3, 300)}`;
}

// only for code you trust: the agent's changes run here too
export class HostEnvironment implements TestEnvironment {
  readonly launcher: Launcher = new HostLauncher();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  setup(dir: string, command: string[] | null): string | null {
    if (!command) return null;
    return setupError(command, this.launcher.run(command[0], command.slice(1), { cwd: dir, env: {}, timeoutMs: this.timeoutMs }));
  }
}

export class DockerEnvironment implements TestEnvironment {
  readonly launcher: Launcher;
  private readonly sandbox: DockerSandbox;
  private readonly timeoutMs: number;

  constructor(sandbox: DockerSandbox, timeoutMs: number) {
    this.sandbox = sandbox;
    this.launcher = sandbox.testLauncher();
    this.timeoutMs = timeoutMs;
  }

  setup(dir: string, command: string[] | null): string | null {
    if (!command) return null;
    return setupError(command, this.sandbox.setup(dir, command, this.timeoutMs));
  }
}
