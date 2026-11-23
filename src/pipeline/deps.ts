import type { Agent } from "../agents/types.ts";
import type { ArmContext } from "../arms.ts";
import type { Git } from "../git.ts";
import type { ResultsStore } from "../results/store.ts";
import type { ValidTask } from "../types.ts";
import { Workspace } from "../workspace.ts";
import { type EvalContext, gradeAgentWork, testsRunOnBase } from "./evaluate.ts";
import type { RunDeps } from "./run.ts";

export function defaultDeps(
  source: Git,
  agent: Agent,
  store: ResultsStore,
  contextFor: (t: ValidTask) => EvalContext,
  armContext: ArmContext,
): RunDeps {
  return {
    agent,
    store,
    armContext,
    createWorkspace: (task, prepare) => Workspace.create(source, task.baseSha, prepare),
    prepareWorkspace: (ws, task) => {
      const ctx = contextFor(task);
      return ctx.env.setup(ws.dir, ctx.runner.setupCommand());
    },
    grade: (ws, task) => gradeAgentWork(contextFor(task), task, ws.dir),
    testsRunOnBase: (task) => testsRunOnBase(contextFor(task), task),
  };
}
