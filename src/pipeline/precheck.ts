import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Arm, ArmContext } from "../arms.ts";
import type { ValidTask } from "../types.ts";
import { contextFilesIn, removeTree } from "../workspace.ts";

export type Skip = { task: ValidTask; reason: string };

function signature(t: ValidTask, arm: Arm, ctx: ArmContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-precheck-"));
  try {
    ctx.source.exportTree(t.baseSha, dir);
    arm.prepare(dir, ctx);
    return JSON.stringify(contextFilesIn(dir));
  } finally {
    removeTree(dir);
  }
}

export function selectRunnable(tasks: ValidTask[], arms: Arm[], ctx: ArmContext): { run: ValidTask[]; skipped: Skip[] } {
  const run: ValidTask[] = [];
  const skipped: Skip[] = [];
  for (const t of tasks) {
    const leak = arms.map((a) => a.leak?.(t, ctx) ?? null).find((r) => r !== null);
    if (leak) {
      skipped.push({ task: t, reason: leak });
      continue;
    }
    const sigs = arms.map((a) => signature(t, a, ctx));
    if (sigs.every((s) => s === sigs[0])) skipped.push({ task: t, reason: "every arm shows the agent the same context at this commit" });
    else run.push(t);
  }
  return { run, skipped };
}
