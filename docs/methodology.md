# Method

How ctxlift builds tasks, what each arm shows the agent, how the sandbox keeps the merged solution out of reach, and how much data a result needs.

## What a run measures

A run is solved when the PR's hidden tests pass after the agent's change, within the run's budget and time limit, with the network limited to the model API (with `--sandbox none` the network is open). A run that hits the budget or the time limit is still graded on whatever the agent left behind. Instructions in a context file that need the network (installing tools, `pre-commit`, fetching) fail in the sandbox, so a file full of them is judged under those conditions.

Each task runs on the code as it was before its PR. The `repo` arm shows the agent the context files as they were at that commit, which for older tasks may be an earlier version of your file or none at all. The `head` arm puts today's context files on each task's old code instead, which is closer to "does my current file help", but today's file may describe code that came later; see [Arms](#arms).

## Task order in the published results

Where more tasks passed validation than we wanted to run (fastmcp and pipecat), `run --limit 25` took the first 25 in plan order. The plan follows the order of the validated tasks file, which is the order `mine` found the PRs in: GitHub's list of closed PRs, most recently updated first.

## Pipeline

1. `mine` picks merged PRs that change product code and tests, are small, and touch neither dependencies nor test configuration.
2. `validate` keeps a task only if the PR's tests fail on the commit the PR was applied to and pass with the PR's code change applied, three times in a row. Both states are built and graded exactly as agent runs are, so a kept task is solvable through that path. The base commit is tested twice and the change three times; tests whose result moves between runs are dropped. So is a task whose test module can't be imported before the change: grading it would depend on guessing names the description never states. This leaves out many PRs that add a new API, so the task set leans toward bug fixes and changes to existing behaviour.
3. `run` starts from the base commit for each task, arm and repetition. It exports the repo into a fresh git repo with one commit and no history or remote, applies the arm (for example, deleting every `AGENTS.md` and `CLAUDE.md`), and runs the agent headless. The prompt is the PR title and description, with testing sections, code blocks, test names and links to the PR removed.
4. Grading starts from a fresh copy of the base commit and installs its dependencies. It then copies over the agent's changes to regular files, leaving out tests, test and dependency configuration, context files and anything that is a symlink, and adds the PR's tests. A run counts as resolved when every fail-to-pass test passes and no pass-to-pass test breaks. If the tests can't run after an agent's change but still run on untouched code, the agent broke them and the run counts as a failure.
5. `report` compares the arms task by task. It gives a bootstrap confidence interval for the success-rate difference, a paired sign-flip permutation test, the smallest difference the data could detect, and the cost ratio.

## Arms

| arm | what the agent sees |
|---|---|
| `repo` | the repository as it was at the task's base commit |
| `none` | every `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` removed at any depth, along with symlinks to them |
| `bare` | as `none`, and every `.claude/` directory (skills, commands, rules, settings) removed as well |
| `head` | `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` as they are at the clone's current commit, placed on each task's old code (the `.claude/` directory stays as it was at the base commit) |

`run` skips tasks where every arm would show the agent the same context, for example when the file didn't exist yet at that commit, so you don't pay for runs that can't show a difference. `mine` already leaves out PRs that edit a context file.

With the `head` arm, `run` also skips tasks where today's context files mention a file the task changes (by path, file name or module path). Today's file can still mention code that was added after a task's commit, so read a `head` result as an upper bound on what the file itself contributes. These skips apply to the whole run, so a `repo,none,head` run compares `repo` and `none` on fewer tasks than a `repo,none` run.

Claude Code loads `CLAUDE.md` automatically; whether and when it also loads `AGENTS.md` depends on the version. In a repo whose only context file is `AGENTS.md`, check that the pinned version loads it before you read anything into a null result.

`none` removes the files the agent loads automatically. The same guidance can still be in files the agent may open on its own (`CONTRIBUTING.md`, `.cursor/rules`, `.github/copilot-instructions.md`, files `CLAUDE.md` imports), so the comparison measures what automatic loading adds.

`none` keeps the repo's `.claude/` directories (skills, commands, rules, settings). Use `bare` to remove them too. MCP tools are unavailable in every arm, because they aren't on the agent's allow-list.

## Keeping the agent away from the answer

The merged solution exists on your machine: in your clone, and possibly as built packages in toolchain caches. By default (`--sandbox docker`) four kinds of container keep it out of reach:

- A setup container installs dependencies into a workspace from the base commit's code, with normal network access.
- The agent's container mounts only its workspace. Each run gets a network of its own with no way out, shared only with that run's relay for the model API. Package indexes, code hosts, DNS, other runs and ports published on your machine are unreachable, and the container holds no credentials.
- The relay holds your token and accepts requests only with a secret that changes on every `ctxlift run`. It forwards only message requests, removes server-side tools (web search, web fetch, code execution, MCP connectors), and refuses content the API would fetch from a URL, so the model API can't be used to reach the web.
- Tests run in a container with no network at all. Nothing the agent wrote runs on your machine.

Every container runs as your user, with no capabilities and limits on memory and processes, apart from one-off containers that give the setup cache and each workspace's virtualenv volume to your user (root with only the ownership capabilities, no network). The virtualenv lives in a Docker volume instead of the mounted workspace, because installing thousands of files through the macOS file share is slow enough to stall parallel runs. [SECURITY.md](../SECURITY.md) lists what the sandbox doesn't cover.

The agent also runs with an allow-list of tools and deny rules for web tools, `curl`, `wget`, `gh`, git network commands and nested `claude` calls. Every tool call is checked afterwards. Outside the sandbox, a run that used a web tool or named the source clone or a toolchain cache in a command or path is marked contaminated and counted as a failure. In the sandbox those calls can't succeed, so they are marked suspect, like commands that may have used the network (`pip install`). Suspect runs are scored by their tests, and the report also shows the result without them. These checks match command text, so they are a heuristic; the sandbox is what blocks access.

`--sandbox none` runs the agent, its code and the tests directly on your machine. It needs no Docker, but leakage can then only be detected, and it is only safe for code you trust.

## How much data you need

Agents are noisy. Suppose the per-task difference has a standard deviation of about 0.35, which is plausible with 3 repetitions (the report computes the real value). The smallest difference you could then detect with 80% power is roughly:

| tasks | smallest difference you can reliably detect |
|---|---|
| 20 | about 22 pts |
| 50 | about 14 pts |
| 100 | about 10 pts |

A "no difference" result from 20 tasks means no large difference, and the report says how small a difference it could have missed. With fewer than about 30 tasks the bootstrap interval tends to be too narrow, so read it together with the permutation p-value. The permutation test is exact up to 16 tasks with a non-zero difference and a Monte Carlo estimate above that.

## Cost

Every run is a full agent session, so measure on `--limit 3 --reps 1` first. On a subscription, runs count against your plan's usage limits. `--budget` caps each run (default $2). Runs that time out report no cost and are left out of the cost figures; runs stopped by the budget count at the cost they reported. When runs lack cost data, the report also gives the cost ratio you would get if they had cost anything between $0 and their budget. That range bounds the effect of the missing data and says nothing about sampling error.

Changing the budget, the time limit, the sandbox mode or (for `head`) the clone's commit starts new runs instead of reusing old ones, and the report warns when a results file mixes them.

## Corrections to the published data

Before publishing, two infrastructure problems turned up. Both are fixed in the published data. Ten runs hit an offline `uv run` rebuild failure: 9 completed runs (8 in pipecat, 1 in python-sdk) had been graded as failures because of it, and one more pipecat run (pipecat-6793, arm none, repetition 1) hit the same error but had already been recorded as an infrastructure failure. All ten were run again. `UV_NO_SYNC` reached the agent containers on 2026-11-21, while the pydantic-ai runs were in progress. That measurement process had started at 14:09 UTC, before the change at 15:28 UTC, and its workers load the sandbox code once at start, so every original run in all four repos ran without it and an agent's own `uv run` could hit the same failure. Only the runs that were run again afterwards (these ten and the 40 below) had it. We did not measure what this did to the agent's behaviour.

Separately, 40 pydantic-ai runs hit an account rate limit (429) that had been recorded as the agent's error. They were run again and the pydantic-ai results regenerated. See the [changelog](../CHANGELOG.md).

## Limitations

- Python with pytest via `uv` only, for now. Adding another test runner means implementing its interface and, for files outside Python's conventions, extending the path rules (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- Claude Code only, for now. Adding another agent means an adapter and, for the sandbox, a relay for its model API.
- The sandbox needs Docker. It runs containers as your user and works on macOS and Linux.
- Tasks come from PRs that ship tests. Repos without tests, or PRs whose description says little, yield few usable tasks. Tasks are not screened for whether the description gives enough to solve them, so some tasks no arm solves.
- Grading runs only the PR's own tests and misses regressions elsewhere in the suite.
- PRs merged before the model's training cutoff may be in its training data. Use `--since` with a date after the cutoff when you can.
- Results hold for one repo, one model and one agent version, and the report states all three. If you compare several arms, report every comparison you ran.
- The agent's code runs inside the test process, as in any benchmark that grades with the project's own tests. Code written to tamper with that process (rewriting the test report, exiting early with success) could fake a pass. ctxlift catches a report that contradicts the exit code, and the setup is not something an agent working on the task would stumble into, but it is not proof against deliberate tampering.
