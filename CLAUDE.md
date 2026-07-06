# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository contains `gradle-mcp`, a containerized MCP server that runs Gradle tasks against a mounted project. The server is fully implemented with 25 passing tests, argument safety (no shell, no free-form flags), and output control. Container hardening (non-root, read-only FS, cap_drop ALL, limits, timeout) is applied via Docker Compose. See [SPEC.md](docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md) and [PLAN.md](docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md) for architecture and design details.

## Development environment

The environment is defined with [devenv](https://devenv.sh) on top of Nix, and is intended to run inside the devcontainer (`.devcontainer.json`, image `ghcr.io/cachix/devenv/devcontainer:latest`). [devenv.nix](devenv.nix) enables:

- **Nix** (`languages.nix`)
- **JavaScript via Bun** (`languages.javascript.bun`) — Bun is the package manager and runtime; there is no `package.json` yet.

Available packages in the shell: `git`, `gh` , `claude-code`, `curl`, `bun`.
If you need a package that is not installed ask the user.

### Running commands (IMPORTANT for agents)

All project tooling (`bun`, `git`, `gh`, `curl`, and anything added to [devenv.nix](devenv.nix)) is provided by the devenv shell. Tool calls (e.g. Bash) do **not** automatically inherit this environment — direnv only activates it for interactive shells. So every command an agent runs MUST be executed inside the devenv shell:

- **Run commands non-interactively with `devenv shell -- <command>`.** Examples:
  - `devenv shell -- bun install`
  - `devenv shell -- bun test`
  - `devenv shell -- bun run <script>`
- Do **not** call `bun`/project tools directly (e.g. bare `bun test`) — outside the devenv shell they may be missing or resolve to the wrong version.
- If a command unexpectedly reports a tool as "not found", you almost certainly forgot the `devenv shell -- ` prefix.

### Common commands

- `devenv shell` — enter the dev shell interactively with all packages available (handled automatically in the devcontainer via direnv).
- `devenv shell -- <command>` — run a single `<command>` inside the dev shell (use this for tool calls).
- `bun ...` — JavaScript/TypeScript runtime, package manager, and test runner once a Bun project is initialized (e.g. `devenv shell -- bun install`, `devenv shell -- bun test`, `devenv shell -- bun run <script>`).

### Common commands

- `devenv shell` — enter the dev shell with all packages available (handled automatically in the devcontainer via direnv).
- `bun install` — install dependencies.
- `bun test` — run the full test suite. Run one file: `bun test src/arg-policy.test.ts`. Gradle integration tests skip when no `gradle` is on PATH.
- `bun run typecheck` — run TypeScript type checking.
- `bun run start` — start the MCP server (requires `PROJECT_DIR`).
- `docker compose up --build` — run the hardened container (edit the project volume first).

## Key files

- [devenv.nix](devenv.nix) — languages and packages for the dev shell. Add tooling here.
- [devenv.yaml](devenv.yaml) — devenv inputs (nixpkgs rolling, `allowUnfree`).
- [.devcontainer.json](.devcontainer.json) — devcontainer image, VS Code extensions, and mounts (binds the host `~/.claude` and `~/.config/claude` into the container).
- `.gitignore` — ignores `.devenv` and `node_modules`.
- [docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md](docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md) — full feature specification.
- [docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md](docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md) — implementation plan (Tasks 1–10).
