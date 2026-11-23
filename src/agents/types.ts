import type { AgentLimit, RunKind, Usage } from "../types.ts";

export interface AgentRunInput {
  cwd: string;
  prompt: string;
  model: string;
  budgetUsd: number;
  timeoutMs: number;
}

export interface AgentRunResult {
  kind: RunKind;
  // true when every following run would fail the same way (logged out, out of quota)
  fatal: boolean;
  subtype: string | null;
  message: string | null;
  usage: Usage;
  // scored as a failure
  audit: string[];
  // recorded for a sensitivity analysis, not scored
  suspect: string[];
  limit: AgentLimit | null;
  modelResolved: string | null;
}

export interface Agent {
  readonly name: string;
  version(): string;
  preflight(): void;
  run(input: AgentRunInput): AgentRunResult;
}

export const EMPTY_USAGE: Usage = {
  costUsd: null,
  turns: null,
  durationMs: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
};
