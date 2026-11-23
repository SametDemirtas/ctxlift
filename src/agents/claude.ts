import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../exec.ts";
import type { Launcher } from "../launcher.ts";
import { type Agent, type AgentRunInput, type AgentRunResult } from "./types.ts";
import { classifyRun } from "./claude/classify.ts";
import { configDirProblems } from "./claude/credentials.ts";

// anything else is denied without prompting (permission mode dontAsk)
const ALLOWED_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "NotebookEdit", "TodoWrite", "Task"];

// enforced as deny rules and checked again by the audit
const DENIED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(gh *)",
  "Bash(git fetch *)",
  "Bash(git pull *)",
  "Bash(git clone *)",
  "Bash(git remote *)",
  "Bash(git ls-remote *)",
  "Bash(claude *)",
];

export interface ClaudeCodeOptions {
  configDir: string;
  forbiddenPaths: string[];
  // required, so nothing falls back to the host by accident
  launcher: Launcher;
}

export class ClaudeCodeAgent implements Agent {
  readonly name = "claude";
  private readonly o: ClaudeCodeOptions;
  private readonly launcher: Launcher;
  private cachedVersion: string | null = null;

  constructor(o: ClaudeCodeOptions) {
    this.o = o;
    this.launcher = o.launcher;
  }

  private env(): Record<string, string> {
    return this.launcher.isolated ? {} : { CLAUDE_CONFIG_DIR: this.o.configDir };
  }

  private static readonly dropEnv = (k: string): boolean => k === "CLAUDECODE" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN");

  version(): string {
    if (this.cachedVersion === null) {
      // a directory of its own: a sandbox gives every working directory its own resources, and the shared temp dir would make parallel ctxlift processes share them
      const dir = mkdtempSync(join(tmpdir(), "ctxlift-version-"));
      let r: ExecResult;
      try {
        r = this.launcher.run("claude", ["--version"], { cwd: dir, env: this.env(), dropEnv: ClaudeCodeAgent.dropEnv, timeoutMs: 120_000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      this.cachedVersion = r.code === 0 ? `${r.stdout.trim()} (${this.launcher.kind})` : "unknown";
    }
    return this.cachedVersion;
  }

  preflight(): void {
    // in a sandbox, credentials belong to the sandbox (it refuses to start without them)
    const problems = this.launcher.isolated ? [] : configDirProblems(this.o.configDir, process.env);
    if (problems.length > 0) throw new Error(`Claude Code is not ready: ${problems.join("; ")}`);
    if (this.version() === "unknown") throw new Error(`\`claude --version\` failed (${this.launcher.kind}); is Claude Code installed there?`);
  }

  run(i: AgentRunInput): AgentRunResult {
    const args = [
      "-p", i.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--model", i.model,
      "--max-budget-usd", String(i.budgetUsd),
      "--permission-mode", "dontAsk",
      "--allowedTools", ...ALLOWED_TOOLS,
      "--disallowedTools", ...DENIED_TOOLS,
      "--no-session-persistence",
    ];
    const r = this.launcher.run("claude", args, { cwd: i.cwd, env: this.env(), dropEnv: ClaudeCodeAgent.dropEnv, timeoutMs: i.timeoutMs });
    return classifyRun(
      { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut, spawnError: r.timedOut ? null : r.error },
      this.o.forbiddenPaths,
      this.launcher.isolated,
    );
  }
}
