export interface Config {
  projectDir: string;
  port: number;
  gradleTimeoutMs: number;
  defaultOutputLines: number;
  maxOutputLines: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env value: ${value}`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const projectDir = env.PROJECT_DIR?.trim();
  if (!projectDir) throw new Error("PROJECT_DIR environment variable is required");
  return {
    projectDir,
    port: num(env.PORT, 3000),
    gradleTimeoutMs: num(env.GRADLE_TIMEOUT_MS, 600000),
    defaultOutputLines: num(env.DEFAULT_OUTPUT_LINES, 500),
    maxOutputLines: num(env.MAX_OUTPUT_LINES, 5000),
  };
}
