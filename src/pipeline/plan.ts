import type { Arm } from "../arms.ts";
import { rng, shuffled } from "../random.ts";
import { createHash } from "node:crypto";
import type { RunSettings, ValidTask } from "../types.ts";

export interface PlanItem {
  key: string;
  task: ValidTask;
  arm: Arm;
  rep: number;
  model: string;
  settings: RunSettings;
}

// changing a setting starts new runs instead of reusing old ones
export const settingsHash = (s: RunSettings): string =>
  createHash("sha256").update(JSON.stringify([s.budgetUsd, s.timeoutMs, s.sandbox, s.headRev])).digest("hex").slice(0, 8);

export const runKey = (repo: string, task: string, arm: string, rep: number, agent: string, model: string, settings: RunSettings): string =>
  [repo, task, arm, rep, agent, model, settingsHash(settings)].join("|");

// repetitions outermost, so drift over time spreads over all arms
// arm order is shuffled from `seed`, so no arm always runs first and meets a cold cache
export function buildPlan(tasks: ValidTask[], arms: Arm[], reps: number, seed: number, agent: string, model: string, settings: RunSettings): PlanItem[] {
  const next = rng(seed);
  const plan: PlanItem[] = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const task of tasks) {
      for (const arm of shuffled(arms, next)) plan.push({ key: runKey(task.repo, task.id, arm.id, rep, agent, model, settings), task, arm, rep, model, settings });
    }
  }
  return plan;
}
