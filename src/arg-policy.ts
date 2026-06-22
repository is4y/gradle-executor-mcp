export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export const TASK_RE = /^[A-Za-z0-9:._-]+$/;
const TEST_FILTER_RE = /^[A-Za-z0-9:._*$#-]+$/;

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
