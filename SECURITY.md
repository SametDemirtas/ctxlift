# Security

ctxlift runs code you don't control. `validate` and grading run the target repository's test suite on your machine, and `run` starts a coding agent that executes shell commands.

With the default `--sandbox docker`:

- the agent runs in a container that mounts only its workspace, with no credentials, on a network of its own where the only reachable host is a relay that forwards model requests and accepts them only with a per-run secret;
- dependency installs run in a separate container with network access, on the base commit's code only;
- tests run in a container with no network, during validation and grading alike, so neither the repository's tests nor anything the agent wrote runs on your machine;
- containers run as your user with all capabilities dropped and limits on memory and processes (short containers that give the setup cache and each workspace's virtualenv volume to your user run as root with only the ownership capabilities and no network).

Grading copies only regular files out of the agent's workspace, never follows symlinks it left, never deletes through a symlinked directory, and reads test reports without following links.

Known limits of the sandbox:

- The agent's network blocks traffic going out, including to ports published on your machine (gateway isolation, Docker 28 or later), but on some Docker setups (OrbStack, for one) a container on the default bridge network can still open a connection into it. The relay is protected by its per-run secret; an agent that starts a server could be reached from another container on your machine.
- Setup containers have normal network access, including services on your machine's loopback through `host.docker.internal`. They run the base commit's build code (for example `uv sync` building the project), so use repositories you trust.
- The dependency cache for setup is shared between runs and repositories.

With `--sandbox none`, the agent, its code and the tests all run on your machine. Deny rules and the tool-call audit then only limit and detect what the agent does. Use it only for repositories you trust.

Your Claude token is read from `~/.ctxlift-token` or `--token-file` (or from `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the environment when no file is given) and handed to the relay container by variable name, so it doesn't appear in process arguments, logs or results. Anyone who can run `docker inspect` on your machine can see it in the relay's configuration. Keep the token file readable only by you, and revoke a token you have pasted anywhere else.

Please report vulnerabilities privately through GitHub security advisories on this repository.
