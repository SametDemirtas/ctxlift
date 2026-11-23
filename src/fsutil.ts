import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".ctxlift"]);

// "confteſt.py", "Conftest.py" and "conftest.py" are one file on macOS
export const foldName = (p: string): string =>
  p.normalize("NFKC").replace(/\u1E9E/g, "ss").toUpperCase().toLowerCase().normalize("NFKC");

const isSkippedDirName = (name: string): boolean => SKIP_DIRS.has(foldName(name));

export const isUnderSkippedDir = (p: string): boolean => p.split("/").slice(0, -1).some(isSkippedDirName);

export function* walk(root: string): Generator<string> {
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isSkippedDirName(e.name)) stack.push(p);
      } else {
        yield p;
      }
    }
  }
}

export function gitBlobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// does not follow a symlink at the path itself; refuses anything that is not a regular file or is larger than maxBytes
export function readRegularFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// atomic, so a reader never sees a half-written file
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}
