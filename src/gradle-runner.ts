import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GradleResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function resolveGradleCommand(projectDir: string): string {
  const wrapper = join(projectDir, "gradlew");
  if (existsSync(wrapper) && statSync(wrapper).isFile()) return wrapper;
  console.error("[gradle-runner] no ./gradlew found; falling back to system 'gradle'");
  return "gradle";
}

export async function runGradle(
  projectDir: string,
  argv: string[],
  timeoutMs: number,
): Promise<GradleResult> {
  const cmd = resolveGradleCommand(projectDir);
  const proc = Bun.spawn([cmd, ...argv], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  let exitCode: number;
  let stdout = "";
  let stderr = "";

  try {
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitedPromise = proc.exited;

    [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      exitedPromise,
    ]);
  } catch (err) {
    // If process was killed, streams might error
    stdout = "";
    stderr = "";
    exitCode = timedOut ? -1 : 1;
  } finally {
    clearTimeout(timer);
  }

  return { exitCode: timedOut ? -1 : exitCode, stdout, stderr, timedOut };
}
