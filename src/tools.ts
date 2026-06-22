import type { Config } from "./config";
import type { GradleResult } from "./gradle-runner";
import { runGradle } from "./gradle-runner";
import { SerialQueue } from "./queue";
import { tailLines } from "./output";
import { validateTask, validateArgs, validateTestFilters } from "./arg-policy";

export interface ToolDeps {
  config: Config;
  queue: SerialQueue;
  run: typeof runGradle;
}

export interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function buildArgvForTask(task: string, args: string[], allowPropertyFlags: boolean): string[] {
  const t = validateTask(task);
  const a = validateArgs(args, allowPropertyFlags);
  return [t, ...a];
}

export function buildArgvForTests(tests: string[], args: string[], allowPropertyFlags: boolean): string[] {
  const filters = validateTestFilters(tests);
  const a = validateArgs(args, allowPropertyFlags);
  return ["test", ...filters, ...a];
}

function clamp(deps: ToolDeps, maxOutputLines: number | undefined): number {
  const requested = maxOutputLines ?? deps.config.defaultOutputLines;
  return Math.min(requested, deps.config.maxOutputLines);
}

async function execute(deps: ToolDeps, argv: string[], maxLines: number): Promise<ToolResult> {
  const res: GradleResult = await deps.queue.run(() =>
    deps.run(deps.config.projectDir, argv, deps.config.gradleTimeoutMs),
  );
  return {
    exitCode: res.exitCode,
    stdout: tailLines(res.stdout, maxLines),
    stderr: tailLines(res.stderr, maxLines),
    timedOut: res.timedOut,
  };
}

export async function listTasks(deps: ToolDeps): Promise<ToolResult> {
  return execute(deps, ["tasks"], clamp(deps, undefined));
}

export async function runGradleTask(
  deps: ToolDeps,
  input: { task: string; args?: string[]; maxOutputLines?: number },
): Promise<ToolResult> {
  const argv = buildArgvForTask(input.task, input.args ?? [], deps.config.allowPropertyFlags);
  return execute(deps, argv, clamp(deps, input.maxOutputLines));
}

export async function runTests(
  deps: ToolDeps,
  input: { tests?: string[]; args?: string[]; maxOutputLines?: number },
): Promise<ToolResult> {
  const argv = buildArgvForTests(input.tests ?? [], input.args ?? [], deps.config.allowPropertyFlags);
  return execute(deps, argv, clamp(deps, input.maxOutputLines));
}
