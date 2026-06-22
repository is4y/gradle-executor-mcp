# --- Builder: compile the server to a standalone binary with Bun. ---
FROM oven/bun:1-debian AS builder
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
# Bundles @modelcontextprotocol/sdk + zod + the Bun runtime into one executable.
RUN bun build --compile --minify --sourcemap ./src/server.ts --outfile gradle-mcp

# --- Runtime: JDK only (Gradle needs a JVM); no Bun, no node_modules, no source. ---
FROM eclipse-temurin:17-jdk-jammy
# Temurin ships no non-root user; create one. Home backs Gradle's $HOME/.gradle cache.
RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=builder --chown=app:app /build/gradle-mcp ./gradle-mcp
USER app
ENV HOME=/home/app PORT=3000
EXPOSE 3000
CMD ["./gradle-mcp"]
