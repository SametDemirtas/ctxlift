import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execBuffer, execOk } from "./exec.ts";

export interface Blob {
  id: string;
  mode: string;
}

// never wait on a credential prompt
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const GIT_TIMEOUT_MS = 10 * 60_000;

export class Git {
  readonly dir: string;
  private readonly config: Readonly<Record<string, string>>;

  constructor(dir: string, config: Readonly<Record<string, string>> = {}) {
    this.dir = dir;
    this.config = config;
  }

  private args(a: string[]): string[] {
    return ["-C", this.dir, ...Object.entries(this.config).flatMap(([k, v]) => ["-c", `${k}=${v}`]), ...a];
  }

  run(...a: string[]): string {
    return execOk("git", this.args(a), { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS }, `git ${a[0]}`);
  }

  has(rev: string): boolean {
    return exec("git", this.args(["cat-file", "-e", `${rev}^{commit}`])).code === 0;
  }

  ensureCommit(sha: string): void {
    if (!this.has(sha)) this.run("fetch", "-q", "origin", sha);
  }

  revParse(rev: string): string | null {
    const r = exec("git", this.args(["rev-parse", "--verify", "-q", `${rev}^{commit}`]));
    return r.code === 0 ? r.stdout.trim() : null;
  }

  changedFiles(from: string, to: string): string[] {
    return this.run("diff", "-z", "--name-only", "--no-renames", from, to).split("\0").filter(Boolean);
  }

  listBlobs(rev: string): Map<string, Blob> {
    const out = new Map<string, Blob>();
    for (const entry of this.run("ls-tree", "-r", "-z", rev).split("\0")) {
      const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (m) out.set(m[3], { id: m[2], mode: m[1] });
    }
    return out;
  }

  // smudge and eol filters applied
  fileAt(rev: string, path: string): Buffer | null {
    return execBuffer("git", this.args(["cat-file", "--filters", `${rev}:${path}`]));
  }

  // uses the index rather than `git archive`, so export-ignore and export-subst don't make the result differ from a checkout
  exportTree(rev: string, dir: string): void {
    const tmp = mkdtempSync(join(tmpdir(), "ctxlift-index-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
      execOk("git", this.args(["read-tree", rev]), { env });
      execOk("git", this.args(["checkout-index", "-a", "-f", `--prefix=${dir.endsWith("/") ? dir : `${dir}/`}`]), { env });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
