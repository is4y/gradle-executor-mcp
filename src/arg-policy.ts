export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export const TASK_RE = /^[A-Za-z0-9:._-]+$/;
const TEST_FILTER_RE = /^[A-Za-z0-9:._*$#-]+$/;

const DENY_FLAGS = new Set([
  "--init-script", "-I", "--include-build", "-b", "--build-file",
  "-c", "--settings-file", "-p", "--project-dir", "--system-prop",
]);

export function validateTask(task: string): string {
  if (!TASK_RE.test(task)) {
    throw new PolicyError(`Invalid task name: ${JSON.stringify(task)}`);
  }
  return task;
}

export function validateTestFilters(tests: string[]): string[] {
  const argv: string[] = [];
  for (const t of tests) {
    if (!TEST_FILTER_RE.test(t)) {
      throw new PolicyError(`Invalid test filter: ${JSON.stringify(t)}`);
    }
    argv.push("--tests", t);
  }
  return argv;
}

export function validateArgs(args: string[], allowPropertyFlags: boolean): string[] {
  for (const arg of args) {
    const head = arg.split(/[=:]/, 1)[0];
    if (DENY_FLAGS.has(head)) {
      throw new PolicyError(`Disallowed Gradle flag: ${head}`);
    }
    if (!allowPropertyFlags && (arg.startsWith("-D") || arg.startsWith("-P"))) {
      throw new PolicyError(`Property flags are disabled: ${arg}`);
    }
  }
  return args;
}
