import type { RunKind, AgentLimit } from "../../types.ts";
import type { AgentRunResult } from "../types.ts";
import { auditToolCalls } from "./audit.ts";
import { parseStream, usageOf } from "./stream.ts";

const LIMIT_SUBTYPES: Record<string, AgentLimit> = { error_max_turns: "turns", error_max_budget_usd: "budget" };
const API_FAILURE = /^\s*API Error: (Connection|Request timed out|fetch failed)/i;
// matched at the start of a message only
const FATAL = /^\s*(Not logged in|Invalid API key|Credit balance is too low|Claude (AI )?usage limit reached|.{0,40}usage limit reached)/i;

// the status can sit anywhere: "API Error: 429" and "API Error: Request rejected (429)" both give 429
export function apiErrorStatus(message: string): number | null {
  const m = /^\s*API Error:([^\n]*)/i.exec(message);
  if (!m) return null;
  const status = /(?:^|[\s(])([1-5]\d\d)(?=[)\s:.,]|$)/.exec(m[1]);
  return status ? Number(status[1]) : null;
}

const isFatalStatus = (status: number | null): boolean => status === 401 || status === 403 || status === 429;
// other client errors come from what the agent built up
const isApiFailureStatus = (status: number | null): boolean => status === 408 || (status !== null && status >= 500);

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

// wording only decides `fatal`
export function classifyRun(p: ProcessOutcome, forbiddenPaths: string[], isolated = false): AgentRunResult {
  const { result, model, toolCalls } = parseStream(p.stdout);
  const { confirmed: audit, suspect } = auditToolCalls(toolCalls, forbiddenPaths, isolated);
  const usage = usageOf(result);
  const text = `${result?.result ?? ""} ${p.stderr}`.trim();
  // the relay refusing what the agent sent (a URL or file source, a malformed body) is the agent's doing; any other relay refusal (secret, path, load) is a setup problem, so infra
  const relayRefusal = /ctxlift relay: (content with a URL|body is not|body could not)/.test(text);
  const relaySetupProblem = !relayRefusal && /ctxlift relay:/.test(text);
  // nothing the relay itself says is about the account, so it never stops the whole run
  const fromRelay = /ctxlift relay:/.test(text);
  const messages = [...(result?.is_error ? [result.result ?? ""] : []), ...p.stderr.split("\n")];
  const fatalMessage = !fromRelay && messages.some((l) => FATAL.test(l) || isFatalStatus(apiErrorStatus(l)));
  // only the run's own result decides an API failure; a retried server error that Claude Code logged and recovered from must not turn the agent's later failure into infrastructure
  const resultMessage = result?.is_error ? (result.result ?? "") : "";
  const apiFailure = API_FAILURE.test(resultMessage) || isApiFailureStatus(apiErrorStatus(resultMessage));
  const make = (kind: RunKind, message: string | null): AgentRunResult => ({
    kind,
    fatal: kind === "infra" && fatalMessage,
    subtype: result?.subtype ?? null,
    message: message ? message.slice(0, 400) : null,
    usage,
    audit,
    suspect,
    limit: (result?.subtype && LIMIT_SUBTYPES[result.subtype]) || null,
    modelResolved: model,
  });
  if (p.timedOut) return make("timeout", "agent timed out");
  if (p.spawnError) return make("infra", p.spawnError);
  if (!result) return make("infra", `no result event (exit ${p.code}): ${p.stderr.slice(0, 300)}`);
  if (!result.is_error && result.subtype === "success") return make("completed", null);
  if (result.subtype && LIMIT_SUBTYPES[result.subtype]) return make("agent_limit", result.subtype);
  if (relaySetupProblem || (!relayRefusal && (fatalMessage || apiFailure))) return make("infra", text || `error subtype ${result.subtype}`);
  return make("agent_error", text || `error subtype ${result.subtype}`);
}
