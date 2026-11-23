import type { Outcome } from "../types.ts";

export interface Classification {
  failToPass: string[];
  passToPass: string[];
  flaky: string[];
  brokenAfter: string[];
}

// fail-to-pass: passed in every run after and in none before
// a test whose result changes between runs on either side is flaky and is not graded
export function classifyTests(beforeRuns: Map<string, Outcome>[], afterRuns: Map<string, Outcome>[]): Classification {
  if (afterRuns.length === 0 || beforeRuns.length === 0) throw new Error("need at least one run before and after");
  const ids = new Set(afterRuns.flatMap((r) => [...r.keys()]));
  const c: Classification = { failToPass: [], passToPass: [], flaky: [], brokenAfter: [] };
  for (const id of [...ids].sort()) {
    const seen = afterRuns.map((r) => r.get(id));
    const before = beforeRuns.map((r) => r.get(id));
    if (seen.some((o) => o !== seen[0]) || before.some((o) => o !== before[0])) {
      c.flaky.push(id);
      continue;
    }
    if (seen[0] === "fail") c.brokenAfter.push(id);
    else if (before[0] === "pass") c.passToPass.push(id);
    else c.failToPass.push(id);
  }
  return c;
}

export function isUsableTask(c: Classification): boolean {
  return c.failToPass.length > 0 && c.brokenAfter.length === 0;
}
