import type { RunRecord } from "../types.ts";

export function parseRecords(text: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (typeof r.key === "string" && typeof r.kind === "string") out.push(r);
    } catch {
      // a partial line left by a crash; that run is redone on resume
    }
  }
  return out;
}

// infra records that a later retry replaced are dropped, so they are not counted twice
export function latestByKey(records: RunRecord[]): RunRecord[] {
  const byKey = new Map<string, RunRecord>();
  for (const r of records) {
    const prev = byKey.get(r.key);
    if (!prev || r.kind !== "infra" || prev.kind === "infra") byKey.set(r.key, r);
  }
  return [...byKey.values()];
}
