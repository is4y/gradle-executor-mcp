# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository currently contains only a development-environment scaffold — there is no application code, build, or test suite yet. The notes below describe the environment so future work can start quickly. Update this file as real code lands.

## Development environment

The environment is defined with [devenv](https://devenv.sh) on top of Nix, and is intended to run inside the devcontainer (`.devcontainer.json`, image `ghcr.io/cachix/devenv/devcontainer:latest`). [devenv.nix](devenv.nix) enables:

- **Nix** (`languages.nix`)
- **JavaScript via Bun** (`languages.javascript.bun`) — Bun is the package manager and runtime; there is no `package.json` yet.

Available packages in the shell: `git`, `claude-code`, `curl`, `bun`.

### Common commands

- `devenv shell` — enter the dev shell with all packages available (handled automatically in the devcontainer via direnv).
- `bun ...` — JavaScript/TypeScript runtime, package manager, and test runner once a Bun project is initialized (e.g. `bun install`, `bun test`, `bun run <script>`).

When adding scripts, builds, lint, or tests, record the exact commands here (including how to run a single test).

## Key files

- [devenv.nix](devenv.nix) — languages and packages for the dev shell. Add tooling here.
- [devenv.yaml](devenv.yaml) — devenv inputs (nixpkgs rolling, `allowUnfree`).
- [.devcontainer.json](.devcontainer.json) — devcontainer image, VS Code extensions, and mounts (binds the host `~/.claude` and `~/.config/claude` into the container).
- `.gitignore` — ignores `.devenv` and `node_modules`.
