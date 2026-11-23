import { isContextPath } from "../context.ts";
import type { PullRequest } from "../types.ts";
import { DEPENDENCY_FILE, isProductCode, isTestFile, NON_PRODUCT_PATH, TEST_CONFIG_FILE } from "./paths.ts";

export interface SelectLimits {
  maxSrcFiles: number;
  maxSrcLines: number;
  minSrcLines: number;
  maxChangedFiles: number;
}

export const DEFAULT_LIMITS: SelectLimits = { maxSrcFiles: 6, maxSrcLines: 250, minSrcLines: 3, maxChangedFiles: 60 };

export type Selection =
  | { ok: true; srcFiles: string[]; testFiles: string[]; removedTestFiles: string[]; srcLines: number }
  | { ok: false; reason: string };

const isHiddenTestFile = (p: string): boolean => isTestFile(p) && !NON_PRODUCT_PATH.test(p);

export function selectPullRequest(pr: PullRequest, limits: SelectLimits = DEFAULT_LIMITS): Selection {
  if (pr.changedFiles > limits.maxChangedFiles || pr.files.length !== pr.changedFiles) {
    return { ok: false, reason: "too many files" };
  }
  if (pr.files.some((f) => DEPENDENCY_FILE.test(f.filename))) return { ok: false, reason: "dependency change" };
  if (pr.files.some((f) => TEST_CONFIG_FILE.test(f.filename))) return { ok: false, reason: "test configuration change" };
  if (pr.files.some((f) => isContextPath(f.filename))) return { ok: false, reason: "edits a context file" };
  const src = pr.files.filter((f) => isProductCode(f.filename));
  const tests = pr.files.filter((f) => isHiddenTestFile(f.filename) && f.status !== "removed");
  const removedTests = [
    ...pr.files.filter((f) => f.status === "removed" && isHiddenTestFile(f.filename)).map((f) => f.filename),
    ...pr.files.filter((f) => f.status === "renamed" && f.previousFilename && isHiddenTestFile(f.previousFilename)).map((f) => f.previousFilename as string),
  ];
  if (tests.length === 0) return { ok: false, reason: "no tests" };
  if (src.length === 0) return { ok: false, reason: "no product code" };
  if (src.length > limits.maxSrcFiles) return { ok: false, reason: "too many source files" };
  const srcLines = src.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (srcLines > limits.maxSrcLines) return { ok: false, reason: "source change too large" };
  if (srcLines < limits.minSrcLines) return { ok: false, reason: "source change too small" };
  return { ok: true, srcFiles: src.map((f) => f.filename), testFiles: tests.map((f) => f.filename), removedTestFiles: removedTests, srcLines };
}
