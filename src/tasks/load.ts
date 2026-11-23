import { readJson } from "../fsutil.ts";
import type { Task, ValidTask } from "../types.ts";

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function check(path: string, data: unknown, fields: Record<string, (v: unknown) => boolean>, hint: string): void {
  if (!Array.isArray(data)) throw new Error(`${path} is not a list of tasks`);
  data.forEach((t, i) => {
    for (const [field, ok] of Object.entries(fields)) {
      if (!ok((t as Record<string, unknown>)?.[field])) throw new Error(`${path}: task ${i} has no valid "${field}". ${hint}`);
    }
  });
}

const TASK_FIELDS = {
  id: (v: unknown) => typeof v === "string",
  repo: (v: unknown) => typeof v === "string",
  prompt: (v: unknown) => typeof v === "string",
  mergeSha: (v: unknown) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v),
  commits: (v: unknown) => Number.isInteger(v),
  allFiles: isStringArray,
  testFiles: isStringArray,
  removedTestFiles: isStringArray,
};

export function loadTasks(path: string): Task[] {
  const data = readJson<unknown>(path);
  check(path, data, TASK_FIELDS, "Create task files with `ctxlift mine`.");
  return data as Task[];
}

export function loadValidTasks(path: string): ValidTask[] {
  const data = readJson<unknown>(path);
  check(
    path,
    data,
    {
      ...TASK_FIELDS,
      baseSha: (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v),
      runner: (v) =>
        typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string" && isStringArray((v as { command?: unknown }).command) &&
        ((v as { setup?: unknown }).setup === undefined || isStringArray((v as { setup?: unknown }).setup)),
      testTargets: (v) => isStringArray(v) && v.length > 0,
      failToPass: (v) => isStringArray(v) && v.length > 0,
      passToPass: isStringArray,
    },
    "Run `ctxlift validate` on the mined tasks first.",
  );
  return data as ValidTask[];
}
