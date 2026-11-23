import type { Outcome } from "../types.ts";
import type { Launcher } from "../launcher.ts";
import { PytestRunner } from "./pytest.ts";
import type { CollectionError, SuiteOutcome, TestRunner } from "./types.ts";

export interface RunnerOptions {
  launcher: Launcher;
  timeoutMs?: number;
}

const FACTORIES: Record<string, (command: string[] | undefined, setup: string[] | undefined, o: RunnerOptions) => TestRunner> = {
  pytest: (command, setup, o) => new PytestRunner(o.launcher, command, o.timeoutMs, setup),
};

export const RUNNER_NAMES = Object.keys(FACTORIES);

// grading uses the exact runner validation used
export function createRunner(spec: { name: string; command?: string[]; setup?: string[] }, o: RunnerOptions): TestRunner {
  const make = FACTORIES[spec.name];
  if (!make) throw new Error(`unknown test runner "${spec.name}" (known: ${RUNNER_NAMES.join(", ")})`);
  return make(spec.command && spec.command.length > 0 ? spec.command : undefined, spec.setup, o);
}

// one file that fails to load can't hide the results of the others
export function runSuite(runner: TestRunner, cwd: string, files: string[]): SuiteOutcome {
  const tests = new Map<string, Outcome>();
  const collectionErrors: CollectionError[] = [];
  for (const file of files) {
    const r = runner.runFile(cwd, file);
    if (r.kind === "infra") return { kind: "infra", reason: `${file}: ${r.reason}` };
    if (r.kind === "collection_error") {
      collectionErrors.push({ file, detail: r.detail });
      continue;
    }
    for (const [id, o] of r.tests) tests.set(id, o);
  }
  return { kind: "ok", tests, collectionErrors };
}
