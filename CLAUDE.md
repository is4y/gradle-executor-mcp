# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository contains `gradle-mcp`, a containerized MCP server that runs Gradle tasks against a mounted project. The server is fully implemented with 30 passing tests, argument safety (no shell, denylist), and output control. Container hardening (non-root, read-only FS, cap_drop ALL, limits, timeout) is applied via Docker Compose. See [SPEC.md](.superpowers/sdd/spec.md) and [PLAN.md](.superpowers/sdd/plan.md) for architecture and design details.

## Development environment

The environment is defined with [devenv](https://devenv.sh) on top of Nix, and is intended to run inside the devcontainer (`.devcontainer.json`, image `ghcr.io/cachix/devenv/devcontainer:latest`). [devenv.nix](devenv.nix) enables:

- **Nix** (`languages.nix`)
- **JavaScript via Bun** (`languages.javascript.bun`) — Bun is the package manager and runtime; there is no `package.json` yet.

Available packages in the shell: `git`, `claude-code`, `curl`, `bun`.

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
- [.superpowers/sdd/spec.md](.superpowers/sdd/spec.md) — full feature specification.
- [.superpowers/sdd/plan.md](.superpowers/sdd/plan.md) — implementation plan (Tasks 1–10).
