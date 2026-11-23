# Changelog

## 0.1.0 (unreleased)

- `mine`, `validate`, `run` and `report` for Python repositories (pytest via uv) with Claude Code.
- Docker sandbox: the agent sees only its workspace and reaches only a relay for the model API, which holds the token and strips server-side tools. Setup runs with network on base code only; tests run with no network.
- Arms `repo`, `none`, `bare` and `head`.
- Validation with fail-to-pass and pass-to-pass tests and flaky-test filtering, built and graded through the same path as agent runs.
- Paired analysis with a bootstrap interval, a sign-flip permutation test, the minimum detectable difference, sensitivity lines without flagged runs and with infrastructure failures counted as failures, and the cost ratio with its censoring range.
- `validate` and `run` resume where they stopped.
- `validate --setup-cmd` for projects whose tests need more than `uv sync --frozen`; it is stored with each task. `validate` refuses to resume results made with other test or setup commands.
- `run --workers N` runs N agents at a time, each in its own sandbox, and hands out runs one at a time so the work spreads across them as they go.
- Hidden tests (grading and validation) and the agent's own commands in the sandbox run with `UV_NO_SYNC=1`, so `uv run` uses the environment the setup step built. Before, `uv run` could decide the project was stale (Docker on macOS doesn't always keep the source directory's inode), try to rebuild it offline and fail, and that grading failure was counted as the agent's. In the published results this hit 10 runs: 9 completed runs graded as failures (8 in pipecat, 1 in python-sdk) and one pipecat run (pipecat-6793, none, repetition 1) already recorded as an infrastructure failure. All 10 were run again. `UV_NO_SYNC` reached the agent containers on 2026-11-21, while the pydantic-ai runs were in progress. That measurement process had started at 14:09 UTC, before the change at 15:28 UTC, and its workers load the sandbox code once at start, so every original run in all four repos ran without it; only the runs that were run again afterwards (these 10 and the 40 rate-limited pydantic-ai runs) had it. The effect on the agent's behaviour was not measured.
- When the hidden tests can't run, grading checks whether the test tool starts at all in the same workspace. If it doesn't, the run is an infrastructure failure, whatever the base check says.
- An API error is classified by its HTTP status wherever the message puts it. Claude Code reports rate limits as "API Error: Request rejected (429)", which was counted as a failed attempt instead of stopping the run. 40 pydantic-ai runs in the results were affected. They were run again and the pydantic-ai results regenerated.
- `bench/`: the run records, tasks and reports behind the results in the README, and `bench/summarize.ts`, which rebuilds them.
