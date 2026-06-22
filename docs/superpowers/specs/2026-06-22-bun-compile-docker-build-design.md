# Docker build using `bun build --compile`

**Date:** 2026-06-22
**Status:** Approved for implementation

## Summary

Rewrite the container image as a two-stage build. A **builder** stage compiles
`src/server.ts` into a single standalone executable with `bun build --compile`.
A **runtime** stage on a slim JDK base receives only that binary — no Bun
runtime, no `node_modules`, no source. The container must still ship a JDK
because the server spawns `./gradlew` / `gradle`, which needs a JVM; `--compile`
only removes the Bun/JS layer from the runtime image, not Java.

## Motivation

The current single-stage image (`oven/bun:1-debian` + JDK) ships the Bun
runtime, `node_modules`, and the TypeScript source at runtime. Compiling to a
standalone binary lets the runtime image carry only the executable and the JDK,
shrinking and simplifying it and removing the dependency-install step from the
runtime layer.

## Constraints

- The compiled Bun binary is **glibc-linked**, so the runtime base must be
  glibc-based (Ubuntu/Debian), not musl/Alpine.
- The runtime image must contain a **JDK 21** (Gradle needs a JVM; `javac` is
  needed for projects that compile Java).
- The image runs under the existing hardening in `docker-compose.yml`:
  read-only root filesystem, tmpfs `/tmp`, `cap_drop: ALL`,
  `no-new-privileges`, non-root user. Bun's compiled executables run in place
  (no extract-to-tmp), so they are compatible with a read-only root FS.

## Build design

### Builder stage

```dockerfile
FROM oven/bun:1-debian AS builder
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build --compile --minify --sourcemap ./src/server.ts --outfile gradle-mcp
```

- `--compile` bundles `@modelcontextprotocol/sdk`, `zod`, and the Bun runtime
  into the `gradle-mcp` executable.
- `--minify` reduces binary size; `--sourcemap` preserves readable stack traces.

### Runtime stage

```dockerfile
FROM eclipse-temurin:21-jdk-jammy
RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=builder --chown=app:app /build/gradle-mcp ./gradle-mcp
USER app
ENV HOME=/home/app PORT=3000
EXPOSE 3000
CMD ["./gradle-mcp"]
```

- `eclipse-temurin:21-jdk-jammy` provides JDK 21 on Ubuntu 22.04 (glibc) and
  ships `ca-certificates`.
- Temurin has no pre-made non-root user, so we create `app` (uid 1000, home
  `/home/app`).
- Gradle defaults its cache to `$HOME/.gradle`; `HOME=/home/app` keeps that
  working and aligns with the cache volume mount.

## docker-compose.yml change

One line changes: the persistent Gradle cache volume mount moves from the
old Bun-image home to the new user's home.

- Before: `- gradle-cache:/home/bun/.gradle`
- After:  `- gradle-cache:/home/app/.gradle`

Everything else is unchanged: the loopback port bind
(`127.0.0.1:3000:3000`), the project volume, `read_only: true`,
tmpfs `/tmp`, `cap_drop: ALL`, `security_opt: no-new-privileges:true`,
`pids_limit`, `mem_limit`, `cpus`, and the commented `JAVA_OPTS` egress note.

## Verification

- `docker compose build` (or `docker build .`) completes successfully.
- `docker compose up` starts the container; the server listens on port 3000
  and a JSON-RPC `tools/list` request to `http://127.0.0.1:3000/` returns the
  three tools (`list_tasks`, `run_gradle_task`, `run_tests`).
- Inside the running container, `java -version` reports JDK 21 (JVM present),
  and the process runs as uid 1000 under the read-only root filesystem.

## Out of scope / unchanged

- Local development stays on `bun run` — `package.json` scripts are untouched.
- JDK version is 21 (bumped from the original image's 17 — a current LTS with broad Gradle support).
- `.dockerignore` already excludes `.git`, `.devenv`, `node_modules`, `docs`,
  and `tests/fixtures`; no change needed.
- Application source (`src/`) and tests are unchanged — this is a packaging
  change only.
