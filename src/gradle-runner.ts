import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

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
    proc.kill(9); // SIGKILL — immediate death so proc.exited resolves promptly
  }, timeoutMs);

  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";

  // Drain stdout and stderr incrementally so we hold no stream reference
  // after the process exits/is killed. A torn-down stream on SIGKILL just
  // ends the async iterator without throwing in Bun, but we guard anyway.
  async function drainStream(
    stream: ReadableStream<Uint8Array>,
    append: (s: string) => void,
  ): Promise<void> {
    try {
      for await (const chunk of stream) {
        append(decoder.decode(chunk, { stream: true }));
      }
      append(decoder.decode()); // flush
    } catch {
      // Stream torn down after kill — ignore
    }
  }

  const stdoutDrain = drainStream(proc.stdout, (s) => { stdout += s; });
  const stderrDrain = drainStream(proc.stderr, (s) => { stderr += s; });

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = timedOut ? -1 : 1;
  } finally {
    clearTimeout(timer);
  }

  // Give drains a brief grace period (50 ms) to capture any trailing bytes,
  // but never block longer than that — avoids EOF hang on orphaned pipes.
  await Promise.race([
    Promise.all([stdoutDrain, stderrDrain]),
    Bun.sleep(50),
  ]);

  return { exitCode: timedOut ? -1 : exitCode, stdout, stderr, timedOut };
}
