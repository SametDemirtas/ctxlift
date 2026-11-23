import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isContextPath } from "./context.ts";
import { exec } from "./exec.ts";
import { foldName, gitBlobId, isUnderSkippedDir, readRegularFile, sha256, walk } from "./fsutil.ts";
import { Git } from "./git.ts";
import type { ContextFile } from "./types.ts";

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const IDENTITY = { "user.email": "bench@ctxlift.local", "user.name": "ctxlift", "commit.gpgsign": "false" };

export interface WorkspaceHandle {
  readonly dir: string;
  contextFiles(): ContextFile[];
  dispose(): void;
}

export interface CopyReport {
  written: string[];
  deleted: string[];
  // never followed or copied
  skippedLinks: string[];
  skippedFiles: string[];
}

// a single commit: no history, remote or future commit for the agent to look at
export class Workspace implements WorkspaceHandle {
  readonly dir: string;
  private readonly rev: string;
  private readonly source: Git;

  private constructor(dir: string, rev: string, source: Git) {
    this.dir = dir;
    this.rev = rev;
    this.source = source;
  }

  // `prepare` runs on the exported tree before the initial commit, so its changes leave no trace in git
  static create(source: Git, rev: string, prepare: (dir: string) => void): Workspace {
    const dir = mkdtempSync(join(tmpdir(), "ctxlift-ws-"));
    try {
      source.exportTree(rev, dir);
      prepare(dir);
      const git = new Git(dir, IDENTITY);
      git.run("init", "-q");
      git.run("add", "-A");
      git.run("commit", "-q", "--no-verify", "--allow-empty", "-m", "base");
      return new Workspace(dir, rev, source);
    } catch (e) {
      removeTree(dir);
      throw e;
    }
  }

  contextFiles(): ContextFile[] {
    return contextFilesIn(this.dir);
  }

  // symlinks in `from` are never followed or copied, so what the agent left behind can't redirect a write
  // nothing in `from` is executed
  copyChangesFrom(from: string, keep: (path: string) => boolean): CopyReport {
    const base = this.source.listBlobs(this.rev);
    const report: CopyReport = { written: [], deleted: [], skippedLinks: [], skippedFiles: [] };
    // macOS file systems usually ignore case, so there a path counts only if it is kept however it is spelled ("Tests/", "PyProject.toml"), and two spellings are the same file
    const folds = existsSync(join(this.dir, ".GIT"));
    const fold = (p: string) => (folds ? foldName(p) : p);
    const kept = (p: string) => keep(p) && keep(p.toLowerCase()) && keep(foldName(p));
    const seen = new Set<string>();
    const writes: Array<{ p: string; data: Buffer; executable: boolean }> = [];
    for (const p of walk(from)) {
      if (!kept(p)) continue;
      seen.add(fold(p));
      const st = lstatSync(join(from, p));
      if (st.isSymbolicLink()) {
        report.skippedLinks.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      const data = readRegularFile(join(from, p), MAX_FILE_BYTES);
      if (!data) {
        report.skippedFiles.push(p);
        continue;
      }
      const blob = base.get(p);
      if (blob && blob.mode !== "120000" && gitBlobId(data) === blob.id) continue;
      writes.push({ p, data, executable: (st.mode & 0o111) !== 0 });
    }
    // deletions first, so a case-only rename (Foo.py -> foo.py) ends with the new name on any file system
    for (const [p, blob] of base) {
      // symlinks are never carried over, so a missing one isn't a deletion either
      if (!kept(p) || seen.has(fold(p)) || isUnderSkippedDir(p) || blob.mode === "120000") continue;
      removeInside(this.dir, p);
      report.deleted.push(p);
    }
    for (const w of writes) {
      writeFileIn(this.dir, w.p, w.data, w.executable);
      report.written.push(w.p);
    }
    return report;
  }

  overlayFrom(rev: string, paths: string[]): void {
    writeFilesAt(this.source, rev, this.dir, paths);
  }

  dispose(): void {
    removeTree(this.dir);
  }
}

export { foldName } from "./fsutil.ts";

export function contextFilesIn(dir: string): ContextFile[] {
  const out: ContextFile[] = [];
  for (const p of walk(dir)) {
    if (!isContextPath(p)) continue;
    const abs = join(dir, p);
    if (lstatSync(abs).isSymbolicLink()) {
      out.push({ path: p, bytes: 0, sha256: `symlink:${readlinkSync(abs)}` });
      continue;
    }
    // setup runs repo code, which could leave a FIFO or a huge file here
    const data = readRegularFile(abs, MAX_FILE_BYTES);
    out.push(data ? { path: p, bytes: data.length, sha256: sha256(data) } : { path: p, bytes: -1, sha256: "unreadable" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function writeFilesAt(source: Git, rev: string, dir: string, paths: string[]): void {
  const blobs = source.listBlobs(rev);
  for (const p of paths) {
    const blob = blobs.get(p);
    if (!blob) {
      removeInside(dir, p);
      continue;
    }
    const content = source.fileAt(rev, p);
    if (!content) throw new Error(`cannot read ${p} at ${rev}`);
    if (blob.mode === "120000") {
      clearPath(dir, p);
      symlinkSync(content.toString(), join(dir, p));
    } else {
      writeFileIn(dir, p, content, blob.mode === "100755");
    }
  }
}

function writeFileIn(dir: string, p: string, content: Buffer, executable: boolean): void {
  clearPath(dir, p);
  writeFileSync(join(dir, p), content);
  chmodSync(join(dir, p), executable ? 0o755 : 0o644);
}

// deletes `dir/p` only if every parent is a real directory; through a symlinked parent the path isn't inside `dir`
function removeInside(dir: string, p: string): void {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) {
    try {
      if (!lstatSync(join(dir, ...parts.slice(0, i))).isDirectory()) return;
    } catch {
      return;
    }
  }
  rmSync(join(dir, p), { force: true, recursive: true });
}

function clearPath(dir: string, p: string): void {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = join(dir, ...parts.slice(0, i));
    try {
      if (!lstatSync(parent).isDirectory()) rmSync(parent, { force: true });
    } catch {
    }
  }
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  rmSync(join(dir, p), { force: true, recursive: true });
}

// never throws: cleanup must not lose a finished run
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    exec("chmod", ["-R", "u+rwx", path]);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // left behind in the temp dir; the OS cleans it up
    }
  }
}
