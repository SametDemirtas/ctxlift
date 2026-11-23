import { isContextPath } from "../context.ts";
import type { TestEnvironment } from "../environment.ts";
import type { Git } from "../git.ts";
import { runSuite } from "../runners/index.ts";
import type { SuiteOutcome, TestRunner } from "../runners/types.ts";
import { isGradingEnvironment } from "../tasks/paths.ts";
import type { ValidTask } from "../types.ts";
import { Workspace } from "../workspace.ts";
import { type Grade, grade } from "./grade.ts";

export const isResetBeforeGrading = (p: string): boolean => isGradingEnvironment(p) || isContextPath(p);

export interface EvalContext {
  source: Git;
  env: TestEnvironment;
  runner: TestRunner;
}

export type HiddenTestSpec = Pick<ValidTask, "baseSha" | "mergeSha" | "testFiles" | "removedTestFiles" | "testTargets">;

// grading and validation share this path, so they use one environment
export function runHiddenTests(ctx: EvalContext, t: HiddenTestSpec, change: (ws: Workspace) => void): SuiteOutcome {
  const ws = Workspace.create(ctx.source, t.baseSha, () => {});
  try {
    const setupError = ctx.env.setup(ws.dir, ctx.runner.setupCommand());
    if (setupError) return { kind: "infra", reason: setupError };
    change(ws);
    ws.overlayFrom(t.mergeSha, [...t.removedTestFiles, ...t.testFiles]);
    const outcome = runSuite(ctx.runner, ws.dir, t.testTargets);
    if (outcome.kind !== "infra") return outcome;
    // when the tests could not run, check whether the test tool starts at all in this same workspace
    const broken = ctx.runner.checkEnvironment(ws.dir);
    return broken === null ? outcome : { kind: "infra", reason: `the test tool does not start in this workspace: ${broken}; tests: ${outcome.reason}`, environment: true };
  } finally {
    ws.dispose();
  }
}

export function gradeAgentWork(ctx: EvalContext, t: ValidTask, agentDir: string): Grade {
  return grade(t, runHiddenTests(ctx, t, (ws) => void ws.copyChangesFrom(agentDir, (p) => !isResetBeforeGrading(p))));
}

export function testsRunOnBase(ctx: EvalContext, t: ValidTask): boolean {
  return runHiddenTests(ctx, t, () => {}).kind === "ok";
}
