# Remove the `args` input from the Gradle MCP

**Date:** 2026-06-22
**Status:** Approved for implementation

## Summary

Remove the free-form `args` input from the `run_gradle_task` and `run_tests`
MCP tools, and delete the now-dead machinery that existed solely to defend it:
the flag denylist (`validateArgs`, `DENY_FLAGS`, `DENY_SHORT_PREFIXES`) and the
`allowPropertyFlags` / `ALLOW_PROPERTY_FLAGS` property-flag gate.

## Motivation

`args` is the only input that lets a caller inject arbitrary Gradle flags.
Today it is defended by a denylist plus a property-flag gate. Removing the
input entirely is strictly stronger than denylisting: the dangerous-flag class
becomes *unreachable* rather than *filtered*, so there is no denylist to keep
exhaustive and no bypass (e.g. attached short-option forms) to chase.

After this change the only caller-controlled inputs are:

- a task name, validated against `^[A-Za-z0-9:._-]+$`,
- `--tests` filters, validated against `^[A-Za-z0-9:._*$#-]+$`,
- a numeric `maxOutputLines` cap.

## Accepted tradeoff

Callers lose the ability to pass benign ad-hoc flags such as `--stacktrace`,
`--no-daemon`, `--rerun-tasks`, and `-D`/`-P` properties. This is intended.
The Gradle runner itself is unaffected — any flags it sets internally stay.

## Changes by component

| File | Change |
|------|--------|
| `src/mcp.ts` | Drop `args` from both `run_gradle_task` and `run_tests` input schemas; reword the tool descriptions to no longer mention extra flags. |
| `src/tools.ts` | `buildArgvForTask(task)` and `buildArgvForTests(tests)` lose the `args` and `allowPropertyFlags` parameters; the input types lose `args?`; drop the `validateArgs` import. |
| `src/arg-policy.ts` | Delete `validateArgs`, `DENY_FLAGS`, `DENY_SHORT_PREFIXES`. Keep `PolicyError`, `validateTask`, `validateTestFilters`, `TASK_RE`, `TEST_FILTER_RE`. |
| `src/config.ts` | Remove the `allowPropertyFlags` field and the `ALLOW_PROPERTY_FLAGS` env parsing. |
| `src/arg-policy.test.ts` | Remove the four `validateArgs` test blocks; drop the `validateArgs` import. |
| `src/tools.test.ts` | Drop the `args: ["--init-script", ...]` rejection assertion; remove `allowPropertyFlags` from the config fixture. |
| `src/integration.test.ts` | Drop the `args: ["--init-script", "/tmp/x"]` rejection assertion. |
| `src/config.test.ts` | Remove the `allowPropertyFlags` assertions and the `ALLOW_PROPERTY_FLAGS` env in the fixtures. |
| `README.md` | Update tool signatures (drop `args?`), remove the `ALLOW_PROPERTY_FLAGS` env-var table row, and reframe the security-model bullet from "argument denylist" to "no free-form flag input". |
| `docker-compose.yml` | Remove the commented `ALLOW_PROPERTY_FLAGS` env line. |
| `docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md` | Reframe the security model: remove `validateArgs`/denylist/property-flag references; describe the reduced input surface. |
| `docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md` | Same reframing where it references args/denylist/property flags. |
| `CLAUDE.md` | Update the status line that mentions the denylist. |

`PolicyError` is retained: it still backs `validateTask` / `validateTestFilters`
and the `policyError` handler in `mcp.ts`.

## Verification

- `bun run typecheck` passes.
- `bun test` passes (full suite, integration tests skip without `gradle`).
- A call that previously passed a denylisted flag via `args` is no longer
  *expressible*: the MCP input schema has no `args` property, so the SDK
  rejects it as an unknown argument rather than the denylist rejecting it.
