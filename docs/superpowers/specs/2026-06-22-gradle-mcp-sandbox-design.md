# Gradle MCP Sandbox — Design

> Superseded in part by [remove-args-input-design](2026-06-22-remove-args-input-design.md): the `args` input and the flag denylist described below were later removed.

**Date:** 2026-06-22
**Status:** Approved (design); ready for implementation planning

## Purpose

A containerized MCP server that gives AI agents a **safe execution environment for running
Gradle** against a single project. Agents connect over HTTP and call a small set of tools to
list tasks, run a task, and run tests. The build runs inside a hardened container so that
arbitrary build/test code cannot harm the host.

## Decisions (locked during brainstorming)

| Topic | Decision |
|-------|----------|
| Core purpose | Run Gradle builds/tasks for agents |
| Code source | A real project **mounted** into the container; the server runs Gradle against that working copy |
| What "safe" means (ranked) | A) contain untrusted build code, D) filesystem blast radius, B) network egress control |
| Where safety lives | Primarily the **container runtime**; the server adds a thin argument-safety layer |
| Tools | `list_tasks`, `run_gradle_task`, `run_tests` |
| Transport | Streamable **HTTP**; persistent container service |
| Scope | **One project per container**; builds **serialized** (one at a time) |
| Auth | **None** — rely on network isolation |
| Output | **Buffered** result (exit code + stdout/stderr); no structured XML parsing |
| Output limit | Per-call `maxOutputLines` (tail-kept), with a default and an enforced ceiling |
| Runtime / invocation | **TypeScript on Bun**, invoking Gradle via `Bun.spawn` with an **argv array (no shell)** |

## Architecture

```
agent ──HTTP (MCP)──▶ [ container: Bun MCP server ──Bun.spawn(argv)──▶ ./gradlew ]
                                  │                                       │
                                  └── serialized build queue             mounted project (rw)
```

The container bundles a JDK + Bun + the server. The Gradle project is mounted as a volume.
Agents reach the server over streamable HTTP on a configurable port. Each tool call is
validated, queued (serialized), executed as a no-shell subprocess with `cwd` pinned to the
project directory, and returned as a buffered result.

The **container runtime is the security boundary**. The server's argument policy is a second
layer that prevents agents from turning a Gradle call into arbitrary-code-execution via
dangerous flags.

## Components

Each unit has one purpose, a clear interface, and is testable in isolation.

- **`config.ts`** — reads environment configuration. No logic beyond parsing/validation.
  - `PROJECT_DIR` — absolute path to the mounted project (required).
  - `PORT` — HTTP port (default e.g. 3000).
  - `GRADLE_TIMEOUT_MS` — per-build wall-clock timeout; build is killed on expiry.
  - `DEFAULT_OUTPUT_LINES` — output lines returned when a call omits `maxOutputLines`.
  - `MAX_OUTPUT_LINES` — hard ceiling; a call requesting more is clamped to this.
- **`arg-policy.ts`** — pure validation, no I/O. Turns agent input into a safe argv or throws.
  - `validateTask(task: string)` — must match `^[A-Za-z0-9:._-]+$`.
  - `validateTestFilters(tests: string[])` — validates `--tests` patterns.
  - Returns the sanitized argv array; throws a descriptive error on any violation.

- **`gradle-runner.ts`** — the **only** place a process is spawned.
  - `runGradle(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>`.
  - Uses `Bun.spawn` with an argv array (no shell), `cwd` = `PROJECT_DIR`, and the timeout.
  - Prefers `./gradlew`; falls back to system `gradle` if no wrapper is present (logged).
  - Knows nothing about MCP or argument policy.

- **`queue.ts`** — serialization primitive. Ensures one Gradle invocation runs at a time;
  concurrent tool calls await their turn.

- **`output.ts`** — `tailLines(text: string, maxLines: number)`. Keeps the **last** `maxLines`
  of combined output; if truncated, prepends `… (N earlier lines omitted)`.

- **`tools.ts`** — defines the three MCP tools and their input schemas; wires
  `arg-policy → queue → gradle-runner → output`.

- **`server.ts`** — boots the MCP server, registers tools, starts the streamable-HTTP
  transport on `PORT`. No Gradle logic.

## Tools

### `list_tasks()`
- No agent-supplied arguments.
- Runs the `tasks` task through `gradle-runner` (so the same wrapper-preferred resolution
  applies) and returns the task listing text (tail-limited to `DEFAULT_OUTPUT_LINES`).

### `run_gradle_task({ task: string, maxOutputLines?: number })`
- Exactly **one** task per call.
- `task` validated against `^[A-Za-z0-9:._-]+$`.
- Runs `./gradlew <task>`.
- Returns `{ exitCode, stdout, stderr }`, output tail-kept to
  `min(maxOutputLines ?? DEFAULT_OUTPUT_LINES, MAX_OUTPUT_LINES)`.

### `run_tests({ tests?: string[], maxOutputLines?: number })`
- Runs the `test` task, optionally with `--tests <pattern>` filters built from `tests`.
- Same validation, same buffered result shape and output limiting as `run_gradle_task`.
- No XML report parsing — raw buffered output (per decision).

## Security model

1. **No shell, ever.** `Bun.spawn(["./gradlew", ...argv])` only — never `sh -c`. This makes
   classic command injection impossible by default (a value like `; rm -rf /` arrives as a
   literal, invalid task name and fails).
2. **Wrapper preferred.** Use `./gradlew` if present (guarantees the project's Gradle version);
   otherwise fall back to system `gradle`, logging the fallback.
3. **Argument policy** (`arg-policy.ts`):
   - Task name must match `^[A-Za-z0-9:._-]+$`.
   - `--tests` patterns are validated.
   - No free-form flags are accepted; only the validated task name and `--tests` filters reach Gradle.
4. **Path pinning.** `cwd` is fixed to `PROJECT_DIR`; no agent input selects paths.
5. **Container hardening** (documentation + provided run/compose config — not server logic):
   - Non-root user.
   - Read-only root filesystem except the mounted project and Gradle caches.
   - `--cap-drop ALL`, memory / CPU / pids limits.
   - `GRADLE_TIMEOUT_MS` kills runaway builds.
   - Network egress restricted via Gradle proxy settings and/or a constrained Docker network
     (e.g. allow only the Gradle/Maven repositories).

## Error handling

- **Policy violation** → MCP tool error with a clear message; **no execution**.
- **Gradle non-zero exit** → returned as a **normal** tool result with `exitCode` + output
  (not a transport error), so agents can read and reason about build failures.
- **Timeout** → process killed; returned as an error result indicating the timeout.

## Testing (TDD)

- **Unit — `arg-policy.ts`** (security-critical): valid tasks; injection attempts; `--tests` validation.
- **Unit — `output.ts`**: tail-keeping, truncation marker, no-op when under the limit.
- **Integration** against a tiny fixture Gradle project:
  - `list_tasks` returns tasks.
  - a passing build → `exitCode 0`.
  - a failing build → non-zero `exitCode` with output.
- Run with `bun test`.

## Delivery

- `package.json` + `bun install` introducing the official MCP TypeScript SDK.
- Source modules as above under (e.g.) `src/`.
- `Dockerfile` — JDK + Bun + server.
- `docker-compose.yml` / `docker run` example demonstrating the hardening flags and the
  project volume mount.
- `README` — configuration (env vars), how agents connect, and the security/hardening notes.
- Update `CLAUDE.md` with the real build/test/run commands once they exist.

## Out of scope (YAGNI)

- Multiple projects per server.
- Parallel builds.
- App-level authentication.
- Structured test-report (XML) parsing / streamed progress.
- The Gradle Tooling API / a JVM server.
