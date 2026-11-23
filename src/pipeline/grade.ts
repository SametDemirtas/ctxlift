import type { SuiteOutcome } from "../runners/types.ts";
import type { ValidTask } from "../types.ts";

export type Grade =
  | { kind: "graded"; resolved: boolean; f2pPassed: number; f2pTotal: number; p2pBroken: number; note: string | null }
  | { kind: "infra"; reason: string; environment?: boolean };

// a test file that no longer loads is the agent's failure; only a runner that couldn't run at all is infrastructure
export function grade(task: ValidTask, suite: SuiteOutcome): Grade {
  if (suite.kind === "infra") return suite.environment ? { kind: "infra", reason: suite.reason, environment: true } : { kind: "infra", reason: suite.reason };
  const passed = (id: string) => suite.tests.get(id) === "pass";
  const f2pPassed = task.failToPass.filter(passed).length;
  const p2pBroken = task.passToPass.filter((id) => !passed(id)).length;
  const note = suite.collectionErrors.length > 0 ? suite.collectionErrors.map((c) => `${c.file} failed to load: ${c.detail}`).join("; ").slice(0, 400) : null;
  return {
    kind: "graded",
    resolved: f2pPassed === task.failToPass.length && p2pBroken === 0,
    f2pPassed,
    f2pTotal: task.failToPass.length,
    p2pBroken,
    note,
  };
}
