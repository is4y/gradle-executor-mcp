# gradle-mcp

A containerized MCP server that lets agents run Gradle tasks/tests against one
mounted project over streamable HTTP, with a no-shell argument-safety layer.

## Tools
- `list_tasks()` — list the project's Gradle tasks.
- `run_gradle_task({ task, maxOutputLines? })` — run one task.
- `run_tests({ tests?, maxOutputLines? })` — run the `test` task, optional `--tests` filters.

All output is buffered, returned as `{ exitCode, stdout, stderr, timedOut }`,
and tail-limited to `maxOutputLines` (default 500, ceiling 5000).

## Configuration (env)
| Var | Default | Meaning |
|-----|---------|---------|
| `PROJECT_DIR` | (required) | Absolute path to the mounted project |
| `PORT` | 3000 | HTTP port |
| `GRADLE_TIMEOUT_MS` | 600000 | Per-build timeout (build killed on expiry) |
| `DEFAULT_OUTPUT_LINES` | 500 | Output lines when a call omits `maxOutputLines` |
| `MAX_OUTPUT_LINES` | 5000 | Hard ceiling for output lines |

## Run
```bash
# edit docker-compose.yml: point the ./your-gradle-project volume at your project
docker compose up --build
```
The MCP endpoint is then at `http://127.0.0.1:3000/`.

## Connecting an agent
Configure your MCP client with a streamable-HTTP server URL of `http://127.0.0.1:3000/`.
There is no app-level auth — only expose the port on a trusted/loopback network.

## Security model
- **No shell:** Gradle is spawned with an argv array; classic command injection is impossible.
- **No free-form flags:** callers cannot pass arbitrary Gradle flags. The only inputs are a
  task name (`^[A-Za-z0-9:._-]+$`), `--tests` filters (`^[A-Za-z0-9:._*$#-]+$`), and a numeric
  output cap — so code-execution / sandbox-escape flags (`--init-script`, `--build-file`,
  `--project-dir`, `-D`/`-P`, etc.) are not expressible.
- **The container is the real boundary:** non-root, read-only FS, `cap_drop: ALL`,
  `no-new-privileges`, pids/mem/cpu limits, and timeout. Egress control is opt-in — see
  the commented `JAVA_OPTS` in `docker-compose.yml` to route Gradle through an allowlisting proxy.
- Builds run arbitrary code by design — never point this at an untrusted project without the container hardening.

## Development
```bash
bun install
bun test          # unit + integration (Gradle tests skip if no gradle on PATH)
bun run start     # needs PROJECT_DIR set
```
