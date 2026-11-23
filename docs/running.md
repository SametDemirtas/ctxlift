# Running ctxlift

Requirements, token setup, setup and test commands, resuming, parallel workers, and what a report looks like.

## Requirements

- Node.js 24 or later
- `git`, and `gh` logged in (for `mine`)
- Docker 28 or later (Docker Desktop or OrbStack on macOS) for the default sandbox. The sandbox image has Python 3.12, `uv`, Node 24 and a pinned Claude Code. Python repos with `uv` and pytest are supported today; `uv` downloads another Python version into the workspace when a repo needs one.
- A Claude token for the sandbox. With a Claude subscription, run `claude setup-token` and save the token to a file only you can read:

  ```sh
  claude setup-token                 # copy the token it prints
  pbpaste > ~/.ctxlift-token && chmod 600 ~/.ctxlift-token
  ```

  ctxlift reads `~/.ctxlift-token` (or `--token-file`) and gives it only to the relay container as an environment variable, so it stays out of process arguments. If `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set in your environment and you don't pass `--token-file`, ctxlift uses that instead, so a leftover API key would bill your API account. Don't paste the token anywhere else.

  With `--sandbox none`, log in once into a separate profile instead:

  ```sh
  CLAUDE_CONFIG_DIR=~/.ctxlift-claude claude   # then /login, then /exit
  ```

## Setup commands, resuming and parallel workers

The first `run` builds the sandbox image, which takes a few minutes. Dependencies are installed with `uv sync --frozen` and tests run with `uv run --frozen pytest`. If the project's own CI installs more than that, for example optional extras its tests import, pass that command to `validate` with `--setup-cmd`, for example `--setup-cmd "uv sync --frozen --all-extras"`, and change the test command with `--test-cmd` (for example to deselect tests that need a network service). Both are stored with each validated task, so `run` grades the same way.

`validate` and `run` save their progress after every task or run. If one stops (a crash, a quota limit, Ctrl-C), run the same command again and it continues where it left off. When you run it again, runs that ended in an infrastructure failure run again too. Three such failures in a row, or an agent that is logged out or out of quota, stop the run. Use a separate `--out` file when you change settings, so one report covers one setup.

To run several agents at once, add `--workers N`. The command then starts N workers, each with its own sandbox and relay (with `--sandbox none`, each on this machine), and hands out runs one at a time, so a worker that finishes early takes the next run and no run is given out twice. Workers start one after another, each once the previous one is ready. Ctrl-C stops them all the same way it stops a single run: each worker finishes or drops its current step, and a second Ctrl-C quits at once and removes the workers' containers. If the coordinator itself is killed outright, its workers stop after their current step and drop that run, so let them finish before you start the command again. If a worker fails (for example the account runs out of credit), no new runs start, and the command ends with an error that says how many runs are left; run it again to do them. With Docker on macOS, four workers is a sensible upper limit for the default memory of the Docker VM.

## Example report

`ctxlift report bench/data/pydantic-ai.jsonl --baseline none --treatment repo` prints:

```
## repo vs none

pydantic/pydantic-ai · claude 2.1.328 (Claude Code) (docker) · model claude-sonnet-5-5

Resolved means the PR's hidden tests pass, within each run's budget and time limit, with the network limited to the model API.

| arm | runs | resolved (per task) | cost / run | cost / resolved | contaminated | suspect | timeouts | limit or error | infra (excluded) |
|---|---|---|---|---|---|---|---|---|---|
| none | 66 | 75.8% | $0.146 | $0.193 | 0 | 2 | 0 | 0 | 0 (+20 retried) |
| repo | 66 | 72.7% | $0.238 | $0.317 | 0 | 1 | 2 | 0 | 0 (+20 retried) |

- Tasks compared: 22 (1 better with repo, 1 worse, 20 tied)
- Success rate difference (repo - none): -3.0 pts (95% CI -13.6 pts to +4.5 pts), paired permutation p = 1.000
- Smallest difference this run could reliably detect: about ±13.6 pts
- Without runs the audit flagged (in the sandbox, suspect commands could not reach the network): -3.0 pts
- Cost ratio per run (repo / none): 1.74x (95% CI 1.53x to 2.00x)
- Contaminated runs count as failures. Suspect runs are scored by their tests and left out of the line without flagged runs.
- Runs left out for infrastructure failures: 0
- Tasks that `run` skipped before starting (same context in every arm, or a possible leak through the head arm) are not counted here.
- 2 runs have no cost data and are left out of the cost figures. If they cost anything between $0 and their budget, the cost ratio lies between 1.58x and 1.99x.
- With 22 tasks the bootstrap interval tends to be too narrow; read it with the permutation p-value

This data does not show a difference in success rate. Differences smaller than about ±13.6 pts can't be ruled out.
```
