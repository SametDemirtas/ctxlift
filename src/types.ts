export type Outcome = "pass" | "fail";

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previousFilename?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  mergeSha: string;
  commits: number;
  changedFiles: number;
  files: PrFile[];
}

export interface Task {
  id: string;
  repo: string;
  pr: number;
  title: string;
  prompt: string;
  mergeSha: string;
  mergedAt: string;
  commits: number;
  // includes the old name of renamed files
  allFiles: string[];
  srcFiles: string[];
  testFiles: string[];
  removedTestFiles: string[];
  srcLines: number;
  promptRemovedLines: number;
}

export interface RunnerSpec {
  name: string;
  command: string[];
  setup?: string[];
}

export interface ValidTask extends Task {
  baseSha: string;
  runner: RunnerSpec;
  testTargets: string[];
  failToPass: string[];
  passToPass: string[];
  flaky: string[];
}

export interface ContextFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Usage {
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export type AgentLimit = "budget" | "turns";

export interface RunSettings {
  budgetUsd: number;
  timeoutMs: number;
  sandbox: string;
  headRev: string;
}

// only "infra" is excluded from scoring and retried on resume
export type RunKind = "completed" | "agent_limit" | "agent_error" | "timeout" | "infra";

export interface RunRecord {
  key: string;
  // so a results file can't silently mix repos
  repo: string;
  task: string;
  arm: string;
  rep: number;
  agent: string;
  agentVersion: string;
  model: string;
  kind: RunKind;
  subtype: string | null;
  resolved: boolean;
  f2pPassed: number;
  f2pTotal: number;
  p2pBroken: number;
  contaminated: boolean;
  audit: string[];
  suspect: string[];
  gradingNote: string | null;
  limit: AgentLimit | null;
  // the requested `model` may be an alias
  modelResolved: string | null;
  // part of the run key
  settings: RunSettings;
  contextFiles: ContextFile[];
  usage: Usage;
  error: string | null;
  at: string;
}
