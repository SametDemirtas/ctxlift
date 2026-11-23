import type { Usage } from "../../types.ts";
import { EMPTY_USAGE } from "../types.ts";

export interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: Record<string, number>;
  message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
}

export interface ParsedStream {
  result: StreamEvent | null;
  model: string | null;
  toolCalls: Array<{ name: string; input: string }>;
}

export function parseStream(stdout: string): ParsedStream {
  let result: StreamEvent | null = null;
  let model: string | null = null;
  const toolCalls: ParsedStream["toolCalls"] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "result") result = ev;
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "tool_use") toolCalls.push({ name: c.name ?? "?", input: JSON.stringify(c.input ?? {}) });
      }
    }
  }
  return { result, model, toolCalls };
}

export function usageOf(ev: StreamEvent | null): Usage {
  if (!ev) return EMPTY_USAGE;
  const u = ev.usage ?? {};
  return {
    costUsd: ev.total_cost_usd ?? null,
    turns: ev.num_turns ?? null,
    durationMs: ev.duration_ms ?? null,
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheCreationTokens: u.cache_creation_input_tokens ?? null,
  };
}
