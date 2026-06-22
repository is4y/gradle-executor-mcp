# Bun provides the runtime; add a JDK so Gradle can run.
FROM oven/bun:1-debian

# Install a JDK (Gradle needs a JVM). The project's ./gradlew downloads the
# correct Gradle distribution on first use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jdk-headless ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src

# Run as the non-root 'bun' user provided by the base image.
USER bun

ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
