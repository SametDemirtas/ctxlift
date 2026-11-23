// relay for the agent sandbox: forwards only message requests, strips server-side tools and refuses URL and file sources, so the model API is no route to the web
// it holds the credentials so the agent container has none, and requires the per-run secret header so other containers can't use it
import http from "node:http";
import https from "node:https";

const UPSTREAM = new URL(process.env.UPSTREAM ?? "https://api.anthropic.com");
const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.RELAY_SECRET ?? "";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const MAX_BODY = 32 * 1024 * 1024;
const MAX_IN_FLIGHT = 8;
const SECRET_HEADER = "x-ctxlift-relay";
const DROP_HEADERS = new Set([
  "host", "authorization", "x-api-key", "content-length", "connection", "accept-encoding", "transfer-encoding",
  "expect", "upgrade", "keep-alive", "te", "trailer", "proxy-authorization", "proxy-connection", SECRET_HEADER,
]);
const OAUTH_BETA = "oauth-2025-04-20";
const UPSTREAM_IDLE_MS = 10 * 60_000;

if (!SECRET || (!API_KEY && !OAUTH)) {
  console.error("RELAY_SECRET and ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN are required");
  process.exit(1);
}

const MAX_DEPTH = 64;

// a URL or stored-file source makes the API fetch it itself; too deep counts as true
function hasUrlSource(v, depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(v)) return v.some((x) => hasUrlSource(x, depth + 1));
  if (v && typeof v === "object") {
    if (v.source && typeof v.source === "object" && (v.source.type === "url" || v.source.type === "file")) return true;
    return Object.values(v).some((x) => hasUrlSource(x, depth + 1));
  }
  return false;
}

const BLOCKED_BETA = /^files-api/i;

function sanitize(body) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) delete body.tools;
  if (Array.isArray(body.tools)) body.tools = body.tools.filter((t) => t && typeof t === "object" && (!t.type || t.type === "custom"));
  delete body.mcp_servers;
  delete body.container;
  return body;
}

function deny(res, status, why) {
  console.log(`DENY ${status} ${why}`);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: `ctxlift relay: ${why}` } }));
}

let inFlight = 0;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.headers[SECRET_HEADER] !== SECRET) return deny(res, 403, "missing or wrong relay secret");
    if (req.method !== "POST" || !ALLOWED_PATHS.has(url.pathname)) return deny(res, 403, `${req.method} ${url.pathname}`);
    if (inFlight >= MAX_IN_FLIGHT) return deny(res, 429, "too many requests in flight");
    inFlight++;
    res.on("close", () => inFlight--);
    // a slow upload is cut; once the body is in, the wait for the model is governed by the upstream timeout
    req.setTimeout(5 * 60_000, () => req.destroy());
    req.on("end", () => req.setTimeout(0));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return deny(res, 400, "body is not JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return deny(res, 400, "body is not a JSON object");
      let body;
      try {
        if (hasUrlSource(parsed)) return deny(res, 403, "content with a URL or file source, or nested too deep");
        body = JSON.stringify(sanitize(parsed));
      } catch {
        return deny(res, 400, "body could not be checked");
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k)) headers[k] = v;
      if (API_KEY) headers["x-api-key"] = API_KEY;
      else {
        headers.authorization = `Bearer ${OAUTH}`;
        const betas = String(headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
        headers["anthropic-beta"] = betas.join(",");
      }
      if (headers["anthropic-beta"]) {
        const kept = String(headers["anthropic-beta"]).split(",").map((s) => s.trim()).filter((b) => b && !BLOCKED_BETA.test(b));
        if (kept.length > 0) headers["anthropic-beta"] = kept.join(",");
        else delete headers["anthropic-beta"];
      }
      headers["content-length"] = Buffer.byteLength(body);
      const up = https.request(
        { hostname: UPSTREAM.hostname, port: Number(UPSTREAM.port || 443), method: "POST", path: url.pathname + url.search, headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.on("error", () => res.destroy());
          r.pipe(res);
        },
      );
      up.setTimeout(UPSTREAM_IDLE_MS, () => up.destroy(new Error("upstream idle timeout")));
      res.on("close", () => up.destroy());
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `relay upstream error: ${e.message}` } }));
      });
      up.end(body);
    });
  })
  .listen(PORT, () => console.log(`relay up on ${PORT} -> ${UPSTREAM.origin}`));
