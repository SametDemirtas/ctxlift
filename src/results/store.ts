import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "../types.ts";
import { parseRecords } from "./records.ts";

export class ResultsStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): RunRecord[] {
    return existsSync(this.path) ? parseRecords(readFileSync(this.path, "utf8")) : [];
  }

  completedKeys(): Set<string> {
    return new Set(this.load().filter((r) => r.kind !== "infra").map((r) => r.key));
  }

  append(r: RunRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const text = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    // if a crash left a partial line, start on a new one so this record stays parseable
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(this.path, `${prefix}${JSON.stringify(r)}\n`);
  }
}
