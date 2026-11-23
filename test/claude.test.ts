import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditToolCalls, mentionsPath } from "../src/agents/claude/audit.ts";
import { apiErrorStatus, classifyRun, type ProcessOutcome } from "../src/agents/claude/classify.ts";
import { configDirProblems } from "../src/agents/claude/credentials.ts";
import { parseStream } from "../src/agents/claude/stream.ts";

const line = (o: unknown) => JSON.stringify(o);
const result = (o: Record<string, unknown>) =>
  line({ type: "result", total_cost_usd: 0.42, num_turns: 7, duration_ms: 1000, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, ...o });
const toolUse = (name: string, input: unknown) => line({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const proc = (stdout: string, extra: Partial<ProcessOutcome> = {}): ProcessOutcome => ({ stdout, stderr: "", code: 0, timedOut: false, spawnError: null, ...extra });

test("parseStream reads the result and tool calls and skips broken lines", () => {
  const s = parseStream([toolUse("Bash", { command: "ls" }), "{not json", result({ subtype: "success", is_error: false })].join("\n"));
  assert.equal(s.result?.subtype, "success");
  assert.deepEqual(s.toolCalls, [{ name: "Bash", input: '{"command":"ls"}' }]);
});

test("classifyRun: success, agent limits, timeout", () => {
  const ok = classifyRun(proc(result({ subtype: "success", is_error: false })), []);
  assert.equal(ok.kind, "completed");
  assert.deepEqual(ok.usage, { costUsd: 0.42, turns: 7, durationMs: 1000, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 });
  assert.equal(classifyRun(proc(result({ subtype: "error_max_turns", is_error: true })), []).kind, "agent_limit");
  assert.equal(classifyRun(proc(result({ subtype: "error_max_budget_usd", is_error: true })), []).kind, "agent_limit");
  const t = classifyRun(proc("", { timedOut: true, code: null }), []);
  assert.equal(t.kind, "timeout");
  assert.equal(t.fatal, false);
});

test("classifyRun: API failures are infra, other execution errors are the agent's, auth/quota is fatal", () => {
  const noResult = classifyRun(proc("", { code: 1, stderr: "API Error: Connection error" }), []);
  assert.equal(noResult.kind, "infra");
  assert.equal(noResult.fatal, false);
  assert.equal(classifyRun(proc("", { code: null, spawnError: "ENOENT spawn claude ENOENT" }), []).kind, "infra");
  const overloaded = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" })), []);
  assert.equal(overloaded.kind, "infra");
  assert.equal(overloaded.fatal, false);
  const agentBroke = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "Tool loop aborted" })), []);
  assert.equal(agentBroke.kind, "agent_error");
  for (const msg of ["Edit failed at line 512", "pytest run timed out", "Implemented OAuth authentication and rate limit handling"]) {
    const r = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: msg })), []);
    assert.equal(r.kind, "agent_error", msg);
    assert.equal(r.fatal, false, msg);
  }
  const done = classifyRun(proc(result({ subtype: "success", is_error: false, result: "Added handling for the usage limit reached error" })), []);
  assert.equal(done.kind, "completed");
  assert.equal(done.fatal, false);
  const loggedOut = classifyRun(proc(result({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" })), []);
  assert.equal(loggedOut.kind, "infra");
  assert.equal(loggedOut.fatal, true);
  assert.equal(classifyRun(proc("", { code: 1, stderr: "Claude usage limit reached" }), []).fatal, true);
});

test("classifyRun reads the HTTP status wherever an API error message puts it", () => {
  const errored = (msg: string) => classifyRun(proc(result({ subtype: "success", is_error: true, result: msg })), []);
  for (const msg of [
    "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    "API Error: 429 rate_limit_error",
    "API Error: 401 authentication_error",
    "API Error: Forbidden (403)",
  ]) {
    const r = errored(msg);
    assert.equal(r.kind, "infra", msg);
    assert.equal(r.fatal, true, msg);
  }
  for (const msg of ["API Error: 500 internal", "API Error: Service unavailable (503)", "API Error: 529 overloaded", "API Error: 408 Request Timeout"]) {
    const r = errored(msg);
    assert.equal(r.kind, "infra", msg);
    assert.equal(r.fatal, false, msg);
  }
  for (const msg of ["API Error: 400 prompt is too long", "API Error: Request too large (413)"]) {
    assert.equal(errored(msg).kind, "agent_error", msg);
  }
  // a status in the agent's own words is not an API error
  assert.equal(errored("Fixed the handler that returned 429 to clients").kind, "agent_error");
  assert.equal(apiErrorStatus("API Error: retry after 1500 ms (429)"), 429);
  assert.equal(apiErrorStatus("API Error: Connection error"), null);
  assert.equal(apiErrorStatus("no error here 500"), null);
  assert.equal(apiErrorStatus("API Error: 400 bad request, then 429"), 400, "the first status wins");
  // a server error Claude Code logged on stderr and recovered from does not make the agent's own failure infrastructure
  const recovered = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "Tool loop aborted" }), { stderr: "API Error: 503 retrying" }), []);
  assert.equal(recovered.kind, "agent_error");
  // a rate limit on stderr stops the run
  const limited = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "Tool loop aborted" }), { stderr: "API Error: Request rejected (429)" }), []);
  assert.equal(limited.fatal, true);
});

test("audit flags network use and forbidden paths in commands and reads, not in content the agent writes", () => {
  const calls = [
    { name: "Bash", input: JSON.stringify({ command: "uv run --frozen pytest tests" }) },
    { name: "Bash", input: JSON.stringify({ command: "cat /src/clone/src/a.py" }) },
    { name: "WebFetch", input: JSON.stringify({ url: "https://example.com" }) },
    { name: "Bash", input: JSON.stringify({ command: "gh pr view 12" }) },
    { name: "Bash", input: JSON.stringify({ command: "cd x && curl -s https://x" }) },
    { name: "Bash", input: JSON.stringify({ command: 'python -c "import urllib.request"' }) },
    { name: "Bash", input: JSON.stringify({ command: "uv pip install mcp==9" }) },
    { name: "Bash", input: JSON.stringify({ command: "git -C /tmp/x fetch origin" }) },
    { name: "Read", input: JSON.stringify({ file_path: "/home/u/.cache/uv/archive-v0/x/mcp/server.py" }) },
    { name: "Grep", input: JSON.stringify({ pattern: "def foo", path: "/src/clone" }) },
    { name: "Read", input: JSON.stringify({ file_path: "/tmp/ws/README.md" }) },
    { name: "Grep", input: JSON.stringify({ pattern: "https://", path: "." }) },
    { name: "Write", input: JSON.stringify({ file_path: "/tmp/ws/docs.md", content: "see https://github.com/x and run curl -s y" }) },
    { name: "Bash", input: JSON.stringify({ command: "uv pip list" }) },
    { name: "Bash", input: JSON.stringify({ command: "echo highlight" }) },
    { name: "Bash", input: JSON.stringify({ command: 'grep -rn "http://localhost" src/ && git commit -m "fix https://x"' }) },
  ];
  const { confirmed, suspect } = auditToolCalls(calls, ["/src/clone", "/home/u/.cache/uv"]);
  assert.deepEqual(
    confirmed.map((c) => c.split(":")[0]),
    ["Bash", "WebFetch", "Read", "Grep"],
    `confirmed: clone read, web tool, uv cache read, clone grep\n${confirmed.join("\n")}`,
  );
  assert.equal(suspect.length, 4, `gh, curl, uv pip install, git fetch\n${suspect.join("\n")}`);
  const all = [...confirmed, ...suspect];
  for (const ok of ["pytest", "README", "highlight", "docs.md", "pip list", "urllib", '"pattern":"https://"']) {
    assert.ok(!all.some((f) => f.includes(ok)), `false positive: ${ok}`);
  }
  const r = classifyRun(proc([toolUse("WebSearch", { query: "x" }), result({ subtype: "success", is_error: false })].join("\n")), []);
  assert.equal(r.audit.length, 1);
});

test("configDirProblems: clean, leaky, logged out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-cfg-test-"));
  try {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "x" } }));
    mkdirSync(join(dir, "plugins", "store"), { recursive: true });
    assert.deepEqual(configDirProblems(dir, {}), [], "plugins/store is Claude Code's own state");
    writeFileSync(join(dir, "CLAUDE.md"), "be nice");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [] }, model: "x", permissions: {} }));
    const p = configDirProblems(dir, {});
    assert.ok(p.includes("CLAUDE.md present"));
    assert.ok(p.includes("settings.json sets hooks"));
    assert.ok(!p.some((x) => x.includes("permissions")), "an empty object is fine");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { a: {} } }));
    const q = configDirProblems(dir, {});
    assert.ok(q.includes(".claude.json has mcpServers"));
    assert.ok(q.includes("not logged in and ANTHROPIC_API_KEY not set"));
    assert.ok(!configDirProblems(dir, { ANTHROPIC_API_KEY: "k" }).includes("not logged in and ANTHROPIC_API_KEY not set"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(configDirProblems("/nonexistent/ctxlift", {})[0], /does not exist/);
});

test("the resolved model and the limit that stopped the agent are recorded", () => {
  const init = line({ type: "system", subtype: "init", model: "claude-sonnet-x" });
  const r = classifyRun(proc([init, result({ subtype: "error_max_budget_usd", is_error: true })].join("\n")), []);
  assert.equal(r.modelResolved, "claude-sonnet-x");
  assert.equal(r.limit, "budget");
  assert.equal(classifyRun(proc(result({ subtype: "error_max_turns", is_error: true })), []).limit, "turns");
  assert.equal(classifyRun(proc(result({ subtype: "success", is_error: false })), []).limit, null);
});

test("client API errors are the agent's, server and connection errors are infra", () => {
  const kind = (msg: string) => classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: msg })), []).kind;
  assert.equal(kind("API Error: 400 prompt is too long"), "agent_error");
  assert.equal(kind("API Error: 413 request too large"), "agent_error");
  assert.equal(kind("API Error: 500 internal"), "infra");
  assert.equal(kind("API Error: 529 overloaded"), "infra");
  assert.equal(kind("API Error: Connection error."), "infra");
});

test("forbidden paths match whole path components only", () => {
  assert.ok(mentionsPath("cat /src/x.py", "/src"));
  assert.ok(mentionsPath('{"file_path":"/src"}', "/src"));
  assert.ok(mentionsPath("ls /home/u/clone/", "/home/u/clone"));
  assert.ok(!mentionsPath("cat /workspace/src/a.py", "/src"));
  assert.ok(!mentionsPath("cat ./src/x", "/src"));
  assert.ok(!mentionsPath("cat /srcfoo/x", "/src"));
  assert.ok(!mentionsPath("anything", ""));
});

test("in the sandbox a web tool call is an attempt (suspect), on the host it is a leak", () => {
  const calls = [{ name: "WebFetch", input: JSON.stringify({ url: "https://github.com/x" }) }];
  assert.equal(auditToolCalls(calls, [], false).confirmed.length, 1);
  const sandboxed = auditToolCalls(calls, [], true);
  assert.equal(sandboxed.confirmed.length, 0);
  assert.equal(sandboxed.suspect.length, 1);
});

test("relay refusals: what the agent sent is its problem, setup problems are infra, none are fatal", () => {
  const r = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "API Error: 403 ctxlift relay: content with a URL source" })), []);
  assert.equal(r.kind, "agent_error");
  assert.equal(r.fatal, false);
  const busy = classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "API Error: 429 ctxlift relay: too many requests in flight" })), []);
  assert.equal(busy.kind, "infra", "relay load or misconfiguration is a setup problem");
  assert.equal(busy.fatal, false);
  assert.equal(classifyRun(proc(result({ subtype: "error_during_execution", is_error: true, result: "API Error: 403 ctxlift relay: missing or wrong relay secret" })), []).kind, "infra");
});

test("credentials: --token-file wins, then the environment, then the default file; bad files are refused", async () => {
  const { loadClaudeCredentials } = await import("../src/agents/claude/credentials.ts");
  const dir = mkdtempSync(join(tmpdir(), "ctxlift-cred-"));
  try {
    const oauth = join(dir, "oauth");
    writeFileSync(oauth, "sk-ant-oat01-abc\n");
    const api = join(dir, "api");
    writeFileSync(api, "sk-ant-api03-xyz");
    const bad = join(dir, "bad");
    writeFileSync(bad, "pbpaste > ~/.ctxlift-token && chmod 600 ~/.ctxlift-token");
    assert.deepEqual(loadClaudeCredentials(oauth, { ANTHROPIC_API_KEY: "env" }), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" });
    assert.deepEqual(loadClaudeCredentials(api, {}), { ANTHROPIC_API_KEY: "sk-ant-api03-xyz" });
    assert.deepEqual(loadClaudeCredentials(undefined, { ANTHROPIC_API_KEY: "env" }, oauth), { ANTHROPIC_API_KEY: "env" });
    assert.deepEqual(loadClaudeCredentials(undefined, {}, oauth), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" });
    assert.throws(() => loadClaudeCredentials(bad, {}), /does not hold a Claude token/);
    assert.throws(() => loadClaudeCredentials(undefined, {}, join(dir, "missing")), /claude setup-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
