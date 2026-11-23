import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, type ExecResult, execOk } from "../exec.ts";
import type { Launcher, LaunchOptions } from "../launcher.ts";

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sandbox");
const WORKDIR = "/workspace";
const HOME = "/home/agent";
// setup containers use the default bridge instead
const EGRESS_NETWORK = "ctxlift-egress";
const RELAY_PORT = 8080;
const RELAY_SECRET_HEADER = "x-ctxlift-relay";
const CACHE_VOLUME = "ctxlift-setup-cache";
const OWNER_LABEL = "ctxlift.owner";
const CPUS = Math.min(4, availableParallelism());
const DOCKER_TIMEOUT_MS = 5 * 60_000;

export interface RelayAccess {
  url: string;
  header: string;
  secret: string;
}

export interface DockerSandboxOptions {
  // given only to the relay container
  credentials: Record<string, string>;
  upstream?: string;
  docker?: string;
}

interface ContainerSpec {
  network: string;
  cwd: string;
  env: Record<string, string>;
  cmd: string[];
  timeoutMs: number;
  mounts?: string[];
}

// the agent container mounts only its workspace and reaches only the relay; tests run with no network at all
export class DockerSandbox {
  private readonly o: Required<DockerSandboxOptions>;
  private readonly image: string;
  private readonly user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  // per-process: agents of this run send it, so no other container can use this run's relay
  private readonly secret = randomBytes(24).toString("hex");
  private readonly relay = `ctxlift-relay-${process.pid}-${randomBytes(3).toString("hex")}`;

  constructor(o: DockerSandboxOptions) {
    this.o = { upstream: "https://api.anthropic.com", docker: "docker", ...o };
    this.image = `ctxlift-sandbox:${sandboxHash()}`;
  }

  // SIGKILL on timeout: the docker client forwards SIGTERM to the container and waits, which can hang forever
  private docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): ExecResult {
    return exec(this.o.docker, args, { timeoutMs, killSignal: "SIGKILL" });
  }

  // so a client blocked on one of them returns at once
  static removeContainersOf(pid: number, docker = "docker"): void {
    const ids = exec(docker, ["ps", "-aq", "--filter", `label=${OWNER_LABEL}=${pid}`], { timeoutMs: 60_000 }).stdout.split("\n").filter(Boolean);
    if (ids.length > 0) exec(docker, ["rm", "-f", ...ids], { timeoutMs: 60_000, killSignal: "SIGKILL" });
  }

  // a hard exit skips cleanup
  private removeStale(): void {
    const alive = (pid: string) => processAlive(Number(pid));
    const owned = (kind: "ps" | "network" | "volume") => {
      const args = kind === "ps" ? ["ps", "-a"] : kind === "network" ? ["network", "ls"] : ["volume", "ls"];
      const id = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
      return this.docker([...args, "--filter", `label=${OWNER_LABEL}`, "--format", `${id} {{.Label "${OWNER_LABEL}"}}`])
        .stdout.split("\n")
        .filter(Boolean)
        .map((l) => l.split(" "))
        .filter(([, pid]) => pid && !alive(pid))
        .map(([id]) => id);
    };
    const containers = owned("ps");
    if (containers.length > 0) this.docker(["rm", "-f", ...containers]);
    const nets = owned("network");
    if (nets.length > 0) this.docker(["network", "rm", ...nets]);
    const vols = owned("volume");
    if (vols.length > 0) this.docker(["volume", "rm", "-f", ...vols]);
  }

  ensure(o: { relay: boolean } = { relay: true }): void {
    const v = this.docker(["version", "--format", "{{.Server.Version}}"]);
    if (v.code !== 0) throw new Error("docker is not available or not running (on macOS, start OrbStack or Docker Desktop)");
    // gateway isolation for agent networks needs Docker 28; older engines accept the option and ignore it
    if (Number(v.stdout.trim().split(".")[0]) < 28) throw new Error(`the sandbox needs Docker 28 or later (found ${v.stdout.trim()})`);
    if (o.relay && Object.keys(this.o.credentials).length === 0) throw new Error("no model API credentials for the sandbox relay");
    this.removeStale();
    if (this.docker(["image", "inspect", this.image]).code !== 0) {
      execOk(this.o.docker, ["build", "-q", "-t", this.image, SANDBOX_DIR], { timeoutMs: 30 * 60_000 }, "docker build");
    }
    if (this.docker(["volume", "inspect", CACHE_VOLUME]).code !== 0) {
      execOk(this.o.docker, ["volume", "create", CACHE_VOLUME], {}, "docker volume create");
    }
    // another ctxlift process may be installing into the cache right now, so files can vanish under chown; only the result matters: the cache root must belong to this user
    execOk(
      this.o.docker,
      [
        "run", "--rm", "--user", "0:0", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
        "--security-opt", "no-new-privileges", "-v", `${CACHE_VOLUME}:/cache`, this.image,
        "sh", "-c", 'chown -R "$1" /cache 2>/dev/null; [ "$(stat -c %u:%g /cache)" = "$1" ]', "sh", this.user,
      ],
      {},
      "docker run chown",
    );
    // a process started at the same moment may create it first
    if (this.docker(["network", "inspect", EGRESS_NETWORK]).code !== 0) {
      const created = this.docker(["network", "create", EGRESS_NETWORK]);
      if (created.code !== 0 && this.docker(["network", "inspect", EGRESS_NETWORK]).code !== 0) {
        throw new Error(`docker network create failed: ${created.stderr.trim().slice(0, 200)}`);
      }
    }
    if (o.relay) this.startRelay();
  }

  private startRelay(): void {
    const names = Object.keys(this.o.credentials);
    execOk(
      this.o.docker,
      [
        "run", "-d", "--name", this.relay, "--label", `${OWNER_LABEL}=${process.pid}`, "--network", EGRESS_NETWORK,
        "--restart", "on-failure:5",
        "--user", this.user, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
        "--memory", "512m", "--pids-limit", "256",
        "-e", `UPSTREAM=${this.o.upstream}`, "-e", `PORT=${RELAY_PORT}`, "-e", "RELAY_SECRET",
        ...names.flatMap((n) => ["-e", n]),
        this.image, "node", "/opt/ctxlift/proxy.mjs",
      ],
      { env: { ...process.env, ...this.o.credentials, RELAY_SECRET: this.secret } },
      "docker run relay",
    );
  }

  private readonly venvs = new Map<string, string>();

  // the virtualenv lives in a Docker volume because installing thousands of files through the macOS file share stalls parallel runs
  private venvVolume(cwd: string): string {
    for (const [dir, vol] of this.venvs) {
      if (!existsSync(dir)) {
        this.docker(["volume", "rm", "-f", vol]);
        this.venvs.delete(dir);
      }
    }
    const known = this.venvs.get(cwd);
    if (known) return known;
    const vol = `ctxlift-venv-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`;
    execOk(this.o.docker, ["volume", "create", "--label", `${OWNER_LABEL}=${process.pid}`, vol], {}, "docker volume create");
    execOk(
      this.o.docker,
      ["run", "--rm", "--user", "0:0", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges", "-v", `${vol}:/v`, this.image, "chown", this.user, "/v"],
      {},
      "docker run chown",
    );
    this.venvs.set(cwd, vol);
    return vol;
  }

  private runContainer(s: ContainerSpec): ExecResult {
    const name = `ctxlift-${randomBytes(6).toString("hex")}`;
    const withVenv = { ...s, mounts: [...(s.mounts ?? []), `${this.venvVolume(s.cwd)}:${WORKDIR}/.venv`] };
    const r = this.docker(containerArgs(withVenv, { name, image: this.image, user: this.user, owner: String(process.pid), cpus: CPUS }), s.timeoutMs);
    if (r.timedOut || r.error || r.signal) {
      // the client died (timeout, output flood) but the container may still run: remove it before the host reads the workspace
      this.docker(["rm", "-f", name], 60_000);
      if (this.docker(["inspect", name]).code === 0) throw new Error(`container ${name} is still running after its client stopped`);
    }
    return r;
  }

  setup(cwd: string, command: string[], timeoutMs: number): ExecResult {
    return this.runContainer({
      network: "bridge",
      cwd,
      env: { UV_PYTHON_INSTALL_DIR: `${WORKDIR}/.ctxlift/python`, UV_LINK_MODE: "copy" },
      cmd: command,
      timeoutMs,
      mounts: [`${CACHE_VOLUME}:${HOME}/.cache`],
    });
  }

  // a network of its own with no way out, shared only with the relay, so agents can't reach each other
  agentLauncher(agentEnv: (relay: RelayAccess) => Record<string, string>): Launcher {
    return {
      kind: "docker",
      isolated: true,
      run: (cmd: string, args: string[], o: LaunchOptions) => {
        const net = `ctxlift-net-${randomBytes(6).toString("hex")}`;
        // gateway isolation keeps the agent away from ports published on the host (Docker 28+)
        const created = this.docker(["network", "create", "--internal", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--label", `${OWNER_LABEL}=${process.pid}`, net]);
        if (created.code !== 0) {
          throw new Error(`could not create an isolated agent network (needs Docker 28 or later): ${created.stderr.trim().slice(0, 200)}`);
        }
        try {
          execOk(this.o.docker, ["network", "connect", net, this.relay], {}, "docker network connect");
          // offline, a `uv run` that decides to sync can only fail, so the agent uses the environment setup built
          const env = { UV_OFFLINE: "1", UV_NO_SYNC: "1", ...agentEnv({ url: `http://${this.relay}:${RELAY_PORT}`, header: RELAY_SECRET_HEADER, secret: this.secret }), ...o.env };
          return this.runContainer({ network: net, cwd: o.cwd, env, cmd: [cmd, ...args], timeoutMs: o.timeoutMs });
        } finally {
          this.docker(["network", "disconnect", "-f", net, this.relay]);
          this.docker(["network", "rm", net]);
        }
      },
    };
  }

  testLauncher(): Launcher {
    return {
      kind: "docker-offline",
      isolated: true,
      run: (cmd: string, args: string[], o: LaunchOptions) =>
        this.runContainer({ network: "none", cwd: o.cwd, env: { UV_OFFLINE: "1", ...o.env }, cmd: [cmd, ...args], timeoutMs: o.timeoutMs }),
    };
  }

  cleanup(): void {
    const filter = ["--filter", `label=${OWNER_LABEL}=${process.pid}`];
    const ids = this.docker(["ps", "-aq", ...filter]).stdout.split("\n").filter(Boolean);
    if (ids.length > 0) this.docker(["rm", "-f", ...ids], 60_000);
    const nets = this.docker(["network", "ls", "-q", ...filter]).stdout.split("\n").filter(Boolean);
    if (nets.length > 0) this.docker(["network", "rm", ...nets], 60_000);
    const vols = this.docker(["volume", "ls", "-q", ...filter]).stdout.split("\n").filter(Boolean);
    if (vols.length > 0) this.docker(["volume", "rm", "-f", ...vols], 60_000);
    this.venvs.clear();
  }
}

export function containerArgs(s: ContainerSpec, c: { name: string; image: string; user: string; owner: string; cpus: number }): string[] {
  const [uid, gid] = c.user.split(":");
  return [
    "run", "--rm", "--init", "--name", c.name, "--label", `${OWNER_LABEL}=${c.owner}`,
    "--network", s.network,
    "--user", c.user,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "1024", "--memory", "8g", "--cpus", String(c.cpus),
    "--tmpfs", `${HOME}:rw,exec,size=2g,uid=${uid},gid=${gid},mode=0700`,
    "-v", `${s.cwd}:${WORKDIR}`, "-w", WORKDIR,
    ...(s.mounts ?? []).flatMap((m) => ["-v", m]),
    ...Object.entries(s.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    c.image, ...s.cmd,
  ];
}

// EPERM means it exists but belongs to another user
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// a changed Dockerfile or relay gets a new image instead of a stale one
function sandboxHash(): string {
  const h = createHash("sha256");
  for (const f of ["Dockerfile", "proxy.mjs"]) {
    const p = join(SANDBOX_DIR, f);
    if (!existsSync(p)) throw new Error(`sandbox file missing: ${p}`);
    h.update(readFileSync(p));
  }
  return h.digest("hex").slice(0, 12);
}
