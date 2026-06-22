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

// Short flags that accept a value and whose attached form (e.g. -I/tmp/x) would
// bypass the exact-match DENY_FLAGS check above.  Checked case-sensitively so
// that e.g. -i (--info, lowercase) is not blocked.
const DENY_SHORT_PREFIXES = ["-I", "-b", "-c", "-p"];

export function validateArgs(args: string[], allowPropertyFlags: boolean): string[] {
  for (const arg of args) {
    // Block attached short-option forms: -I/tmp/x, -bbuild.gradle, etc.
    // These are longer than the two-char flag itself (length > 2) so they
    // can never be caught by the exact-match DENY_FLAGS check.
    if (DENY_SHORT_PREFIXES.some((pfx) => arg.startsWith(pfx) && arg.length > pfx.length)) {
      throw new PolicyError(`Disallowed Gradle flag: ${arg}`);
    }
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
