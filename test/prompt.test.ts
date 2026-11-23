import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "../src/tasks/prompt.ts";

const body = `<!-- template comment -->
## Motivation and Context
Tools with a \`Dict[str, X]\` return annotation produce the wrong output schema.

## How Has This Been Tested?
Added test_dict_return_schema in tests/server/test_func_metadata.py.
Ran the full suite.

## Breaking Changes
None.

- [x] I have added tests
- [ ] Docs updated

\`\`\`diff
- old line
+ new line
\`\`\`

See https://github.com/org/repo/pull/123 and https://github.com/org/repo/commit/abc for background.
Closes #3755`;

test("keeps the problem statement", () => {
  const { prompt } = buildPrompt("Treat Dict return annotations like dict", body);
  assert.match(prompt, /# Treat Dict return annotations like dict/);
  assert.match(prompt, /produce the wrong output schema/);
  assert.match(prompt, /## Breaking Changes/);
  assert.match(prompt, /Closes #3755/);
});

test("drops testing sections, test names, checklists, diffs, comments and PR links", () => {
  const { prompt, removedLines } = buildPrompt("t", body);
  for (const leak of ["test_dict_return_schema", "tests/server", "Ran the full suite", "I have added tests", "+ new line", "template comment", "/pull/123", "/commit/abc"]) {
    assert.ok(!prompt.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(removedLines >= 6);
});

test("bold pseudo-headings end at the next heading", () => {
  const { prompt } = buildPrompt("t", "**Testing**\nran test_x\n\n## Notes\nkeep me");
  assert.ok(!prompt.includes("ran test_x"));
  assert.match(prompt, /keep me/);
});

test("an empty body still yields a usable prompt", () => {
  const { prompt } = buildPrompt("Fix the thing", "");
  assert.match(prompt, /# Fix the thing$/);
});

test("all fenced code is removed, including ~~~ blocks, and a # comment inside code doesn't cut the body", () => {
  const b = "Problem statement.\n\n```python\n# Test the new helper\ndef new_helper(): ...\n```\n\n~~~\nsecret patch\n~~~\n\nMore context after.";
  const { prompt } = buildPrompt("t", b);
  assert.ok(!prompt.includes("new_helper"));
  assert.ok(!prompt.includes("secret patch"));
  assert.match(prompt, /Problem statement/);
  assert.match(prompt, /More context after/);
});
