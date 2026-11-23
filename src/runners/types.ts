import type { Outcome, RunnerSpec } from "../types.ts";

export type FileOutcome =
  | { kind: "ran"; tests: Map<string, Outcome> }
  | { kind: "collection_error"; detail: string }
  | { kind: "infra"; reason: string };

export interface TestRunner {
  readonly spec: RunnerSpec;
  isTarget(path: string): boolean;
  setupCommand(): string[] | null;
  // they can hold built copies of later code, so agents must not read them
  cachePaths(): string[];
  runFile(cwd: string, file: string): FileOutcome;
  // loads none of the code under test, so a failure here is the environment's
  checkEnvironment(cwd: string): string | null;
}

export interface CollectionError {
  file: string;
  detail: string;
}

export type SuiteOutcome =
  | { kind: "ok"; tests: Map<string, Outcome>; collectionErrors: CollectionError[] }
  | { kind: "infra"; reason: string; environment?: boolean };
