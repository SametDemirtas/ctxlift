import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RelayAccess } from "../../sandbox/docker.ts";
import { readJson } from "../../fsutil.ts";

export function configDirProblems(configDir: string, env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (!existsSync(configDir)) return [`${configDir} does not exist; log in once with CLAUDE_CONFIG_DIR=${configDir} claude`];
  for (const f of ["CLAUDE.md", "skills", "agents", "commands", "hooks", "output-styles", "plugins/installed_plugins.json", "plugins/cache"]) {
    if (existsSync(join(configDir, f))) problems.push(`${f} present`);
  }
  const settingsPath = join(configDir, "settings.json");
  if (existsSync(settingsPath)) {
    const s = readJson<Record<string, unknown>>(settingsPath);
    for (const k of ["hooks", "env", "enabledPlugins", "mcpServers", "permissions", "apiKeyHelper", "outputStyle"]) {
      if (s[k] !== undefined && JSON.stringify(s[k]) !== "{}" && JSON.stringify(s[k]) !== "[]") problems.push(`settings.json sets ${k}`);
    }
  }
  const statePath = join(configDir, ".claude.json");
  const state = existsSync(statePath) ? readJson<Record<string, any>>(statePath) : {};
  if (state.mcpServers && Object.keys(state.mcpServers).length > 0) problems.push(".claude.json has mcpServers");
  if (!state.oauthAccount && !env.ANTHROPIC_API_KEY) problems.push("not logged in and ANTHROPIC_API_KEY not set");
  return problems;
}

export const CLAUDE_DEFAULTS = { model: "sonnet", configDir: join(homedir(), ".ctxlift-claude"), tokenFile: join(homedir(), ".ctxlift-token") };

// the relay swaps the placeholder key for the real credentials
export function claudeSandboxEnv(relay: RelayAccess): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: relay.url,
    ANTHROPIC_API_KEY: "ctxlift-relay-adds-the-real-key",
    ANTHROPIC_CUSTOM_HEADERS: `${relay.header}: ${relay.secret}`,
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function loadClaudeCredentials(file: string | undefined, env: NodeJS.ProcessEnv = process.env, defaultFile = CLAUDE_DEFAULTS.tokenFile): Record<string, string> {
  if (!file && env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  if (!file && env.CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN };
  const path = file ? resolve(file) : defaultFile;
  if (!existsSync(path)) {
    throw new Error(`no Claude credentials: run \`claude setup-token\` and save the token to ${defaultFile}, or pass --token-file`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^sk-ant-\S+$/.test(token)) throw new Error(`${path} does not hold a Claude token (expected one line starting with sk-ant-)`);
  return token.startsWith("sk-ant-oat") ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: token };
}
