
const TEST_SECTION = /^(how (has|was) this been tested|test(s|ing)?( plan| coverage| notes)?|verification|validation|how to test)\b/i;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_HEADING = /^\*\*(.+?)\*\*:?\s*$/;
const TEST_NAME = /\btest_\w+\.py\b|\b\w+_test\.py\b|\b\w+\.(test|spec)\.[cm]?[jt]sx?\b|\btests?\/[\w./-]+|\bdef test_\w+|\btest_\w+\s*\(|::test_\w+/i;
const PR_OR_COMMIT_URL = /https?:\/\/github\.com\/[^\s)]+\/(pull|commit|compare)\/[^\s)]+/gi;

export interface PromptResult {
  prompt: string;
  removedLines: number;
}

function stripSections(lines: string[]): { kept: string[]; removed: number } {
  const kept: string[] = [];
  let removed = 0;
  let skipLevel: number | null = null;
  for (const line of lines) {
    const h = HEADING.exec(line);
    const b = h ? null : BOLD_HEADING.exec(line);
    if (h || b) {
      const level = h ? h[1].length : 7;
      const title = (h ? h[2] : (b as RegExpExecArray)[1]).trim();
      if (skipLevel !== null && level <= skipLevel) skipLevel = null;
      if (skipLevel === null && TEST_SECTION.test(title)) {
        skipLevel = level;
        removed++;
        continue;
      }
    }
    if (skipLevel !== null) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  return { kept, removed };
}

// a fence is three or more backticks or tildes, maybe indented, closed by the same character at least as long
function stripCodeBlocks(text: string): { text: string; removed: number } {
  const out: string[] = [];
  let removed = 0;
  let fence: { ch: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      removed++;
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      removed++;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), removed };
}

export function buildPrompt(title: string, body: string): PromptResult {
  const noComments = body.replace(/<!--[\s\S]*?-->/g, "");
  const { text: noCode, removed: codeLines } = stripCodeBlocks(noComments);
  const { kept, removed: sectionLines } = stripSections(noCode.split("\n"));
  let removed = codeLines + sectionLines;
  const lines = kept.filter((l) => {
    const drop = /^\s*[-*] \[[ xX]\]/.test(l) || TEST_NAME.test(l);
    if (drop) removed++;
    return !drop;
  });
  const cleaned = lines
    .join("\n")
    .replace(PR_OR_COMMIT_URL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
  const prompt = [
    "Make the change described below to the repository in the current directory.",
    "Work until the change is complete. Do not open a pull request, push, or fetch anything from the network.",
    "",
    `# ${title.trim()}`,
    ...(cleaned ? ["", cleaned] : []),
  ].join("\n");
  return { prompt, removedLines: removed };
}
