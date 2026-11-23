import type { ParsedStream } from "./stream.ts";

const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
// a hit is suspect, not proof: the command may have been denied or offline
const NETWORK_COMMAND =
  /(^|[\s;&|(`])(curl|wget|gh)\s|\bpip3?\s+(install|download)\b|\buv\s+(add|pip\s+(install|download))\b|\bnpm\s+(i|install|view)\b|\bgit\s+(-C\s+\S+\s+)?(fetch|pull|clone|ls-remote)\b/;

function reach(name: string, input: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return input;
  }
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return String(o.file_path ?? o.notebook_path ?? "");
  if (name === "Bash") return String(o.command ?? "");
  return JSON.stringify(o);
}

export interface Audit {
  confirmed: string[];
  suspect: string[];
}

// whole path components only
export function mentionsPath(text: string, path: string): boolean {
  if (!path) return false;
  const p = path.replace(/\/+$/, "");
  let i = text.indexOf(p);
  while (i !== -1) {
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + p.length] ?? "";
    if (!/[\w.-]/.test(before) && (after === "" || after === "/" || !/[\w.-]/.test(after))) return true;
    i = text.indexOf(p, i + 1);
  }
  return false;
}

export function auditToolCalls(calls: ParsedStream["toolCalls"], forbiddenPaths: string[], isolated = false): Audit {
  const a: Audit = { confirmed: [], suspect: [] };
  for (const c of calls) {
    const where = reach(c.name, c.input);
    const line = `${c.name}: ${where.slice(0, 160)}`;
    const risky = NETWORK_TOOLS.has(c.name) || forbiddenPaths.some((p) => mentionsPath(where, p));
    // in a sandbox those paths aren't mounted and web tools have no network, so such a call is an attempt
    if (risky && !isolated) a.confirmed.push(line);
    else if (risky) a.suspect.push(line);
    else if (c.name === "Bash" && NETWORK_COMMAND.test(where)) a.suspect.push(line);
  }
  return a;
}
