
// case-insensitive because macOS file systems are
const CONTEXT_FILE_NAME = /^(AGENTS|CLAUDE|CLAUDE\.local)\.md$/i;

const AGENT_CONFIG_DIR = /(^|\/)\.claude\//;

export const isContextFileName = (name: string): boolean => CONTEXT_FILE_NAME.test(name);

export const isContextPath = (path: string): boolean => isContextFileName(path.split("/").pop() ?? "") || AGENT_CONFIG_DIR.test(path);

export function instructionFilesAt(blobs: Iterable<string>): string[] {
  return [...blobs].filter((p) => isContextFileName(p.split("/").pop() ?? ""));
}
