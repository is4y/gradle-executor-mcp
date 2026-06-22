# GitHub Actions CI/CD Pipeline — Design

**Date:** 2026-06-22
**Status:** Approved
**Topic:** Continuous integration and tag-triggered image publishing for `gradle-mcp`.

## Goal

Add a GitHub Actions pipeline that:

1. Keeps `main` verifiably green by running the full test suite and type checking on every pull request and push to `main`.
2. Builds and publishes the hardened Docker image to GitHub Container Registry (GHCR) on version-tag pushes, gated on the tests passing first.

CI exercises the integration tests (which otherwise skip when no `gradle` is on `PATH`), since the Gradle-spawning layer — output control, timeout, exit-code handling — is the riskiest part of the server.

## Structure

Two workflow files, split by trigger rather than one file with conditional jobs:

- `.github/workflows/ci.yml` — pull requests targeting `main`, and pushes to `main`.
- `.github/workflows/release.yml` — pushes of tags matching `v*`.

## `ci.yml` — test workflow

**Triggers:** `pull_request` (base `main`), `push` (branch `main`).

**Concurrency:** group keyed on the workflow + ref, `cancel-in-progress: true`, so a newer push supersedes an in-progress run on the same ref.

**Job `test`** on `ubuntu-latest`:

1. `actions/checkout`.
2. `oven-sh/setup-bun` — Bun 1.x; cache the install store keyed on `bun.lock`.
3. `actions/setup-java` — Temurin 21 (matches the runtime image's JDK).
4. `gradle/actions/setup-gradle` — provisions the **latest stable** Gradle onto `PATH` and handles Gradle caching. With `gradle` available, the integration tests run against `tests/fixtures/real-project` instead of skipping.
5. `bun install --frozen-lockfile`.
6. `bun run typecheck` (`tsc --noEmit`).
7. `bun test` — full suite, including the now-active integration tests.

## `release.yml` — build & publish workflow

**Trigger:** `push` of tags matching `v*`.

**Permissions:** `contents: read`, `packages: write` (GHCR push via the built-in `GITHUB_TOKEN`; no additional secrets).

**Job `test`** — reuses the same setup-and-test steps as `ci.yml`'s `test` job so a broken tag never ships. (Implementation may extract these into a reusable workflow called by both, or duplicate the steps — decided at plan time.)

**Job `publish`** — `needs: test`, on `ubuntu-latest`:

1. `actions/checkout`.
2. `docker/login-action` → GHCR (`ghcr.io`) using `${{ github.actor }}` / `${{ secrets.GITHUB_TOKEN }}`.
3. `docker/metadata-action` → derive image tags `ghcr.io/<owner>/gradle-mcp:<git-tag>` and `ghcr.io/<owner>/gradle-mcp:latest`.
4. `docker/build-push-action` → build the multi-stage `Dockerfile` and push, using GitHub Actions layer caching (`cache-from`/`cache-to: type=gha`).

## What is not in scope

- No deployment/CD beyond publishing the image.
- No image push on PRs or `main` pushes — image publishing happens only on `v*` tags.
- No multi-arch build, no signing/attestation (can be added later if needed).

## Acceptance / verification

- **CI:** open a test pull request against `main`; confirm the `test` job runs, the integration tests execute (not skip), typecheck passes, and the suite is green.
- **Release:** push a throwaway pre-release tag (e.g. `v0.0.0-test`); confirm tests gate the run, the image builds, and it appears in GHCR with the expected tags. Validate workflow YAML locally with `act` first where available.
