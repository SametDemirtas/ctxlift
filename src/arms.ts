import { lstatSync, readlinkSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { instructionFilesAt, isContextFileName, isContextPath } from "./context.ts";
import { walk } from "./fsutil.ts";
import type { Git } from "./git.ts";
import type { ValidTask } from "./types.ts";
import { writeFilesAt } from "./workspace.ts";

export interface ArmContext {
  source: Git;
  headRev: string;
}

export interface Arm {
  readonly id: string;
  readonly description: string;
  prepare(dir: string, ctx: ArmContext): void;
  // such tasks are skipped
  leak?(task: ValidTask, ctx: ArmContext): string | null;
}

function removeMatching(dir: string, match: (path: string, linkTarget: string) => boolean): string[] {
  const removed: string[] = [];
  for (const p of walk(dir)) {
    const abs = join(dir, p);
    const target = lstatSync(abs).isSymbolicLink() ? basename(readlinkSync(abs)) : "";
    if (match(p, target)) {
      rmSync(abs, { force: true });
      removed.push(p);
    }
  }
  return removed.sort();
}

export function removeContextFiles(dir: string): string[] {
  return removeMatching(dir, (p, target) => isContextFileName(basename(p)) || isContextFileName(target));
}

function removeAllAgentContext(dir: string): string[] {
  return removeMatching(dir, (p, target) => isContextPath(p) || isContextFileName(target));
}

function useHeadContextFiles(dir: string, ctx: ArmContext): void {
  removeContextFiles(dir);
  writeFilesAt(ctx.source, ctx.headRev, dir, instructionFilesAt(ctx.source.listBlobs(ctx.headRev).keys()));
}

// today's files can name code a task's PR added; and a PR that edited a context file documents its own change
function headLeak(t: ValidTask, ctx: ArmContext): string | null {
  if (t.allFiles.some((f) => isContextPath(f))) return "the PR itself edited a context file";
  const text = instructionFilesAt(ctx.source.listBlobs(ctx.headRev).keys())
    .map((p) => ctx.source.fileAt(ctx.headRev, p)?.toString("utf8") ?? "")
    .join("\n");
  const named = t.srcFiles.find((f) => mentionsFile(text, f));
  return named ? `today's context files mention ${named}, which the task changes` : null;
}

export function mentionsFile(text: string, file: string): boolean {
  const name = file.split("/").pop() ?? file;
  const stem = file.replace(/\.[^./]+$/, "");
  const parts = stem.split("/");
  const modules = parts.map((_, i) => parts.slice(i).join(".")).filter((m) => m.includes("."));
  const generic = /^(__init__|index|main|utils?|types|base)$/.test(name.replace(/\.[^.]+$/, ""));
  const suffixes = parts.map((_, i) => file.split("/").slice(i).join("/")).filter((x) => x.includes("/"));
  const needles = [file, ...suffixes, ...(generic ? [] : [name]), ...modules];
  return needles.some((n) => new RegExp(`(^|[^\\w./-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(text));
}

export const ARMS: Readonly<Record<string, Arm>> = {
  repo: { id: "repo", description: "the repository as it was at each task's base commit", prepare: () => {} },
  none: { id: "none", description: "AGENTS.md / CLAUDE.md / CLAUDE.local.md removed, and symlinks to them", prepare: (dir) => void removeContextFiles(dir) },
  bare: { id: "bare", description: "as none, plus every .claude/ directory removed", prepare: (dir) => void removeAllAgentContext(dir) },
  head: { id: "head", description: "context files replaced by today's versions (the clone's HEAD)", prepare: useHeadContextFiles, leak: headLeak },
};

export const ARM_IDS = Object.keys(ARMS);

export function parseArms(list: string): Arm[] {
  const ids = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length < 2) throw new Error("need at least two arms to compare, e.g. --arms repo,none");
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate arm in "${list}"`);
  return ids.map((id) => {
    const arm = ARMS[id];
    if (!arm) throw new Error(`unknown arm "${id}" (known: ${ARM_IDS.join(", ")})`);
    return arm;
  });
}
