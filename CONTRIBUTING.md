# Contributing

## Setup

```sh
npm install
npm run check      # typecheck and unit tests
npm run dev -- --help
```

Node 24 runs the TypeScript sources directly by stripping types, so syntax that needs a compiler is off limits: `enum`, `namespace`, and constructor parameter properties (`constructor(private x: T)`). Use `import type` for type-only imports. `tsconfig.json` enforces this with `erasableSyntaxOnly`. The npm package ships compiled JavaScript from `dist/` (`npm run build`).

## Layout

| path | role |
|---|---|
| `src/cli.ts` | argument parsing and wiring |
| `src/types.ts` | shared data types (tasks, run records) |
| `src/tasks/` | mining PRs (`github.ts`, `mine.ts`), selecting tasks, building prompts, loading task files |
| `src/pipeline/` | base-commit resolution, validation, the shared grading path (`evaluate.ts`), planning, precheck, running |
| `src/runners/` | test runners behind the `TestRunner` interface |
| `src/agents/` | coding agents behind the `Agent` interface, and their registry entries |
| `src/launcher.ts`, `src/environment.ts`, `src/sandbox/` | where agent and test processes run: on the host, or in Docker containers |
| `sandbox/` | the sandbox image and the model API relay |
| `src/workspace.ts` | the isolated copy of the repo an agent works in, and safe file copying |
| `src/arms.ts`, `src/context.ts` | experimental conditions, and what counts as context |
| `src/stats.ts`, `src/report.ts`, `src/results/` | analysis, output, and the results file |
| `src/exec.ts`, `src/git.ts`, `src/fsutil.ts`, `src/args.ts`, `src/random.ts` | processes, git, files, argument checks, seeded randomness |

Decisions live in pure functions (selection, prompt cleaning, classification, grading, statistics) with tests that start no processes. Processes start only through `exec.ts` (git through `git.ts`), and writes into a workspace go through `workspace.ts`. Files written by code under test or by an agent are read with `readRegularFile` from `fsutil.ts`.

## Adding a test runner

1. Implement `TestRunner` in `src/runners/<name>.ts`:
   - `isTarget` says which hidden test-side files are test modules to run.
   - `runFile` runs through the `Launcher` it was created with and reports `ran`, `collection_error` (the file could not load) or `infra` (the runner could not run at all). Read reports with `readRegularFile`: they are written by code under test.
   - `setupCommand` installs the workspace's dependencies before the agent starts, or returns null.
   - `cachePaths` lists toolchain caches outside the repo that the agent must not read.
2. Register it in `src/runners/index.ts`.
3. Add unit tests for exit-code and report parsing.

`src/tasks/paths.ts` and the skipped directories in `src/fsutil.ts` list Python and JavaScript conventions. A runner for another ecosystem may need entries there too, and its toolchain must be in the sandbox image.

## Adding an agent

1. Implement `Agent` in `src/agents/<name>.ts`.
   - `preflight` must refuse a host setup that would leak the operator's own configuration into runs.
   - `run` goes through the `Launcher` it is given, so it works the same on the host and in the sandbox. `launcher.isolated` says which one it is. It classifies outcomes from the process and its structured output as `completed`, `agent_limit`, `agent_error`, `timeout` or `infra`, and sets `fatal` only for problems that would fail every following run.
   - In the `AgentRunResult` it returns, `audit` lists tool calls that provably reached outside the task and `suspect` lists calls that may have.
2. Register it in `src/agents/index.ts` with its default model, how to load its credentials, and the environment that points it at the sandbox relay (`sandboxEnv`).
3. For the sandbox: install it in `sandbox/Dockerfile`. The relay in `sandbox/proxy.mjs` speaks the Anthropic Messages API; an agent for another API needs a relay mode for it.
4. Add fixture-based tests for output parsing, classification and the audit.

## Pull requests

Run `npm run check` before opening one. A change to what gets measured (selection, prompts, grading, statistics) needs a test for the intended behaviour and a note in the PR on how it changes results.
