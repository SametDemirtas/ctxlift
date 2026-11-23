import type { Launcher } from "../launcher.ts";
import type { RelayAccess } from "../sandbox/docker.ts";
import { ClaudeCodeAgent } from "./claude.ts";
import { CLAUDE_DEFAULTS, claudeSandboxEnv, loadClaudeCredentials } from "./claude/credentials.ts";
import type { Agent } from "./types.ts";

export interface AgentSettings {
  configDir?: string;
  forbiddenPaths: string[];
  launcher: Launcher;
}

export interface AgentEntry {
  defaultModel: string;
  create(s: AgentSettings): Agent;
  loadCredentials(file: string | undefined): Record<string, string>;
  sandboxEnv(relay: RelayAccess): Record<string, string>;
}

const AGENTS: Record<string, AgentEntry> = {
  claude: {
    defaultModel: CLAUDE_DEFAULTS.model,
    create: (s) => new ClaudeCodeAgent({ configDir: s.configDir ?? CLAUDE_DEFAULTS.configDir, forbiddenPaths: s.forbiddenPaths, launcher: s.launcher }),
    loadCredentials: (file) => loadClaudeCredentials(file),
    sandboxEnv: claudeSandboxEnv,
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);

export function agentEntry(name: string): AgentEntry {
  const e = AGENTS[name];
  if (!e) throw new Error(`unknown agent "${name}" (known: ${AGENT_NAMES.join(", ")})`);
  return e;
}
