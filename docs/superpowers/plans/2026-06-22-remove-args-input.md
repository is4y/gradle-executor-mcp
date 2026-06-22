# Remove the `args` Input from the Gradle MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the free-form `args` input from the `run_gradle_task` and `run_tests` MCP tools and delete the now-dead denylist and property-flag machinery.

**Architecture:** Three tasks, ordered so the full test suite and `tsc --noEmit` stay green after every commit. Task 1 shrinks the tool surface (callers can no longer pass `args`), leaving the old policy/config code present-but-unused. Task 2 deletes that now-dead code. Task 3 updates the docs. After this change the only caller-controlled inputs are a regex-validated task name, regex-validated `--tests` filters, and a numeric output cap.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`), `@modelcontextprotocol/sdk`, Zod.

## Global Constraints

- Runtime/package manager is **Bun**. Run tests with `bun test`; typecheck with `bun run typecheck`.
- TypeScript `strict: true` is on.
- `PolicyError`, `validateTask`, `validateTestFilters`, `TASK_RE`, `TEST_FILTER_RE` in `src/arg-policy.ts` are **retained** — they still back the `task` and `tests` inputs and the `mcp.ts` error handler.
- The Gradle runner (`src/gradle-runner.ts`) and queue/output modules are **not** touched.
- Each task ends with `bun test` (full suite) and `bun run typecheck` both green, then a commit.

---

## File-by-file impact

- **Modify** `src/mcp.ts` — drop `args` from both tool input schemas.
- **Modify** `src/tools.ts` — drop `args` + `allowPropertyFlags` from `buildArgvForTask`/`buildArgvForTests`, the input types, and the `validateArgs` import.
- **Modify** `src/arg-policy.ts` — delete `validateArgs`, `DENY_FLAGS`, `DENY_SHORT_PREFIXES`.
- **Modify** `src/config.ts` — delete `allowPropertyFlags` field and `ALLOW_PROPERTY_FLAGS` parsing.
- **Modify** tests: `src/tools.test.ts`, `src/integration.test.ts`, `src/arg-policy.test.ts`, `src/config.test.ts`.
- **Modify** docs: `README.md`, `docker-compose.yml`, `CLAUDE.md`, `docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md`, `docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md`.

---

## Task 1: Shrink the MCP tool surface (remove `args`)

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/tools.ts`
- Test: `src/tools.test.ts`, `src/integration.test.ts`

**Interfaces:**
- Consumes: `validateTask`, `validateTestFilters`, `PolicyError` (unchanged) from `src/arg-policy.ts`; `Config` from `src/config.ts` (still has `allowPropertyFlags` after this task — we simply stop reading it).
- Produces (new signatures later tasks/tests rely on):
  - `buildArgvForTask(task: string): string[]`
  - `buildArgvForTests(tests: string[]): string[]`
  - `runGradleTask(deps, input: { task: string; maxOutputLines?: number }): Promise<ToolResult>`
  - `runTests(deps, input: { tests?: string[]; maxOutputLines?: number }): Promise<ToolResult>`

- [ ] **Step 1: Update `tools.test.ts` to the new no-`args` contract**

Replace the four affected tests so they call the new signatures and drop the policy-violation test (that behavior moves from "denylist rejects" to "not expressible"). The final file is:

```typescript
import { test, expect } from "bun:test";
import { buildArgvForTask, buildArgvForTests, listTasks, runGradleTask, runTests } from "./tools";
import { SerialQueue } from "./queue";
import { PolicyError } from "./arg-policy";
import type { Config } from "./config";
import type { GradleResult } from "./gradle-runner";

const config: Config = {
  projectDir: "/p", port: 3000, gradleTimeoutMs: 1000,
  defaultOutputLines: 500, maxOutputLines: 3, allowPropertyFlags: false,
};

function fakeRun(captured: string[][]): (dir: string, argv: string[], t: number) => Promise<GradleResult> {
  return async (_dir, argv) => {
    captured.push(argv);
    return { exitCode: 0, stdout: "1\n2\n3\n4\n5", stderr: "", timedOut: false };
  };
}

test("buildArgvForTask validates and assembles argv", () => {
  expect(buildArgvForTask("build")).toEqual(["build"]);
});

test("buildArgvForTask rejects bad task before building", () => {
  expect(() => buildArgvForTask("a; rm")).toThrow(PolicyError);
});

test("buildArgvForTests prepends 'test' and --tests filters", () => {
  expect(buildArgvForTests(["com.x.T"]))
    .toEqual(["test", "--tests", "com.x.T"]);
});

test("runGradleTask passes argv to runner and clamps output", async () => {
  const captured: string[][] = [];
  const deps = { config, queue: new SerialQueue(), run: fakeRun(captured) };
  const r = await runGradleTask(deps, { task: "build" });
  expect(captured[0]).toEqual(["build"]);
  // maxOutputLines ceiling is 3 -> last 3 lines + marker
  expect(r.stdout).toBe("… (2 earlier lines omitted)\n3\n4\n5");
});

test("runTests builds the test argv", async () => {
  const captured: string[][] = [];
  const deps = { config, queue: new SerialQueue(), run: fakeRun(captured) };
  await runTests(deps, { tests: ["com.x.T"] });
  expect(captured[0]).toEqual(["test", "--tests", "com.x.T"]);
});

test("listTasks runs the 'tasks' task", async () => {
  const captured: string[][] = [];
  const deps = { config, queue: new SerialQueue(), run: fakeRun(captured) };
  await listTasks(deps);
  expect(captured[0]).toEqual(["tasks"]);
});
```

Note: `config` still carries `allowPropertyFlags: false` here — that field is removed in Task 2. `PolicyError` is still imported (used by the bad-task test).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/tools.test.ts`
Expected: FAIL — `buildArgvForTask` still requires 3 arguments, so the new one-arg calls are a type/call mismatch (or the assertions don't match the old `args`-aware impl).

- [ ] **Step 3: Update `src/tools.ts` to drop `args` and `allowPropertyFlags`**

Replace the file with:

```typescript
import type { Config } from "./config";
import type { GradleResult } from "./gradle-runner";
import { runGradle } from "./gradle-runner";
import { SerialQueue } from "./queue";
import { tailLines } from "./output";
import { validateTask, validateTestFilters } from "./arg-policy";

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

export function buildArgvForTask(task: string): string[] {
  return [validateTask(task)];
}

export function buildArgvForTests(tests: string[]): string[] {
  return ["test", ...validateTestFilters(tests)];
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
  input: { task: string; maxOutputLines?: number },
): Promise<ToolResult> {
  const argv = buildArgvForTask(input.task);
  return execute(deps, argv, clamp(deps, input.maxOutputLines));
}

export async function runTests(
  deps: ToolDeps,
  input: { tests?: string[]; maxOutputLines?: number },
): Promise<ToolResult> {
  const argv = buildArgvForTests(input.tests ?? []);
  return execute(deps, argv, clamp(deps, input.maxOutputLines));
}
```

- [ ] **Step 4: Update `src/mcp.ts` to drop `args` from both schemas**

In `src/mcp.ts`, change the `run_gradle_task` `inputSchema` (lines 34-38) to remove the `args` line:

```typescript
      inputSchema: {
        task: z.string().describe("Exactly one Gradle task name, e.g. 'build'"),
        maxOutputLines: z.number().int().positive().optional().describe("Tail this many output lines"),
      },
```

And change the `run_tests` `inputSchema` (lines 53-57) to remove the `args` line:

```typescript
      inputSchema: {
        tests: z.array(z.string()).optional().describe("JUnit test filters, e.g. 'com.x.MyTest'"),
        maxOutputLines: z.number().int().positive().optional().describe("Tail this many output lines"),
      },
```

Leave the descriptions, handlers, `ok`, and `policyError` unchanged.

- [ ] **Step 5: Remove the `args`-rejection test from `src/integration.test.ts`**

Delete the final test (lines 36-39):

```typescript
test("denied flag is rejected without executing (no Gradle needed)", async () => {
  await expect(runGradleTask(deps, { task: "succeed", args: ["--init-script", "/tmp/x"] }))
    .rejects.toThrow(PolicyError);
});
```

Then remove the now-unused `PolicyError` import (line 6: `import { PolicyError } from "./arg-policy";`). Leave the `Config` fixture (with `allowPropertyFlags: false`) as-is — it is cleaned up in Task 2.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test src/tools.test.ts src/integration.test.ts && bun run typecheck`
Expected: PASS. `tools.test.ts` passes; `integration.test.ts` Gradle tests skip if no `gradle` on PATH; typecheck is clean (`validateArgs`/`allowPropertyFlags` still exist but are now unused — strict mode does not flag unused exports/fields).

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS (all files green).

- [ ] **Step 8: Commit**

```bash
git add src/mcp.ts src/tools.ts src/tools.test.ts src/integration.test.ts
git commit -m "feat: remove the args input from run_gradle_task and run_tests"
```

---

## Task 2: Delete the dead denylist and property-flag machinery

**Files:**
- Modify: `src/arg-policy.ts`
- Modify: `src/config.ts`
- Test: `src/arg-policy.test.ts`, `src/config.test.ts`, `src/tools.test.ts`, `src/integration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Config` without the `allowPropertyFlags` field; `arg-policy.ts` exporting only `PolicyError`, `TASK_RE`, `validateTask`, `validateTestFilters`.

- [ ] **Step 1: Remove the `validateArgs` tests from `src/arg-policy.test.ts`**

Delete the four `validateArgs` tests (lines 24-67: `"validateArgs allows benign flags"`, `"validateArgs rejects code-execution / escape flags"`, `"validateArgs gates -D/-P on allowPropertyFlags"`, `"validateArgs blocks attached short-option forms (bypass fix)"`, `"validateArgs still allows benign flags after bypass fix"`) and drop `validateArgs` from the import on line 2. The final file is:

```typescript
import { test, expect } from "bun:test";
import { validateTask, validateTestFilters, PolicyError } from "./arg-policy";

test("validateTask accepts normal task names", () => {
  expect(validateTask("build")).toBe("build");
  expect(validateTask(":app:compileJava")).toBe(":app:compileJava");
});

test("validateTask rejects injection-y values", () => {
  for (const bad of ["build; rm -rf /", "build && curl x", "$(whoami)", "../escape", "a b"]) {
    expect(() => validateTask(bad)).toThrow(PolicyError);
  }
});

test("validateTestFilters builds --tests argv", () => {
  expect(validateTestFilters(["com.x.MyTest", "com.x.MyTest#method", "com.x.*"]))
    .toEqual(["--tests", "com.x.MyTest", "--tests", "com.x.MyTest#method", "--tests", "com.x.*"]);
});

test("validateTestFilters rejects shell metacharacters", () => {
  expect(() => validateTestFilters(["a; rm -rf /"])).toThrow(PolicyError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/arg-policy.test.ts`
Expected: FAIL — `validateArgs` is still exported but the import now omits it; this step's failure is the type/lint signal that the source still needs trimming. (If it happens to pass at runtime, proceed — the source edit in Step 3 is still required.)

- [ ] **Step 3: Trim `src/arg-policy.ts` to the retained surface**

Replace the file with:

```typescript
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
```

- [ ] **Step 4: Run the arg-policy test to verify it passes**

Run: `bun test src/arg-policy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update `src/config.test.ts` to drop `allowPropertyFlags`**

Remove the `allowPropertyFlags` assertion (line 11) and, in the second test, remove `ALLOW_PROPERTY_FLAGS: "true"` from the env object and the `allowPropertyFlags` assertion (line 23). The final file is:

```typescript
import { test, expect } from "bun:test";
import { loadConfig } from "./config";

test("loadConfig applies defaults when only PROJECT_DIR set", () => {
  const cfg = loadConfig({ PROJECT_DIR: "/work/project" });
  expect(cfg.projectDir).toBe("/work/project");
  expect(cfg.port).toBe(3000);
  expect(cfg.gradleTimeoutMs).toBe(600000);
  expect(cfg.defaultOutputLines).toBe(500);
  expect(cfg.maxOutputLines).toBe(5000);
});

test("loadConfig reads overrides and parses numbers", () => {
  const cfg = loadConfig({
    PROJECT_DIR: "/p", PORT: "8080", GRADLE_TIMEOUT_MS: "1000",
    DEFAULT_OUTPUT_LINES: "10", MAX_OUTPUT_LINES: "20",
  });
  expect(cfg.port).toBe(8080);
  expect(cfg.gradleTimeoutMs).toBe(1000);
  expect(cfg.defaultOutputLines).toBe(10);
  expect(cfg.maxOutputLines).toBe(20);
});

test("loadConfig throws without PROJECT_DIR", () => {
  expect(() => loadConfig({})).toThrow("PROJECT_DIR");
});
```

- [ ] **Step 6: Remove `allowPropertyFlags` from `src/config.ts`**

Delete the `allowPropertyFlags: boolean;` line from the `Config` interface (line 7) and the `allowPropertyFlags: env.ALLOW_PROPERTY_FLAGS?...` line from the returned object (line 26). The final file is:

```typescript
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
```

- [ ] **Step 7: Remove `allowPropertyFlags` from the two `Config` test fixtures**

The field no longer exists, so the fixtures in `src/tools.test.ts` and `src/integration.test.ts` are now excess-property type errors under strict mode and must be trimmed.

In `src/tools.test.ts`, change the fixture (lines 8-11) to:

```typescript
const config: Config = {
  projectDir: "/p", port: 3000, gradleTimeoutMs: 1000,
  defaultOutputLines: 500, maxOutputLines: 3,
};
```

In `src/integration.test.ts`, change the fixture (lines 12-15) to:

```typescript
const config: Config = {
  projectDir, port: 3000, gradleTimeoutMs: 120000,
  defaultOutputLines: 1000, maxOutputLines: 5000,
};
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS — full suite green; `tsc --noEmit` clean with no remaining references to `validateArgs`, `allowPropertyFlags`, or `ALLOW_PROPERTY_FLAGS`.

- [ ] **Step 9: Commit**

```bash
git add src/arg-policy.ts src/arg-policy.test.ts src/config.ts src/config.test.ts src/tools.test.ts src/integration.test.ts
git commit -m "refactor: delete dead Gradle-flag denylist and property-flag config"
```

---

## Task 3: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docker-compose.yml`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md`
- Modify: `docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `README.md`**

Change the tool signatures (lines 8-9) to drop `args?`:

```markdown
- `run_gradle_task({ task, maxOutputLines? })` — run one task.
- `run_tests({ tests?, maxOutputLines? })` — run the `test` task, optional `--tests` filters.
```

Delete the `ALLOW_PROPERTY_FLAGS` row from the env table (line 22).

Replace the "Argument denylist" security bullet (lines 37-38) with a bullet describing the reduced surface:

```markdown
- **No free-form flags:** callers cannot pass arbitrary Gradle flags. The only inputs are a
  task name (`^[A-Za-z0-9:._-]+$`), `--tests` filters (`^[A-Za-z0-9:._*$#-]+$`), and a numeric
  output cap — so code-execution / sandbox-escape flags (`--init-script`, `--build-file`,
  `--project-dir`, `-D`/`-P`, etc.) are not expressible.
```

- [ ] **Step 2: Update `docker-compose.yml`**

Delete the commented property-flags line (line 12: `# ALLOW_PROPERTY_FLAGS: "true"   # opt-in to -D/-P`). Leave the `JAVA_OPTS` egress comment intact.

- [ ] **Step 3: Update `CLAUDE.md`**

In the Status paragraph (line 7), replace `argument safety (no shell, denylist)` with `argument safety (no shell, no free-form flags)` and update the test count if `bun test` reports a different number after Task 2 (run `bun test` and read the summary; the four `validateArgs` tests and two `args`-rejection tests were removed). Use the actual reported count.

- [ ] **Step 4: Update the original design spec**

In `docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md`:
- Remove the `ALLOW_PROPERTY_FLAGS` config bullet (line 56).
- Remove the `validateArgs(args: string[])` bullet from the `arg-policy.ts` description (line 60).
- In the tool signatures (lines 89, 96), drop `args?: string[]`; on line 91 drop `; \`args\` validated against the denylist`.
- Replace the `Argument policy` denylist sub-bullets (the `**Denylist** rejects…` / `unless ALLOW_PROPERTY_FLAGS` text around lines 114-115) with: `No free-form flags are accepted; only the validated task name and \`--tests\` filters reach Gradle.`
- In the Testing section (line 135), drop `each denylisted flag` and `property-flag gating` from the arg-policy test list.
- Add a note near the top of the file: `> Superseded in part by [remove-args-input-design](2026-06-22-remove-args-input-design.md): the \`args\` input and the flag denylist described below were later removed.`

- [ ] **Step 5: Annotate the original implementation plan**

`docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md` is a historical build log. Do **not** rewrite its task steps. Instead add a single note directly under its top-level heading:

```markdown
> **Update (2026-06-22):** The `args` tool input and the Gradle-flag denylist
> (`validateArgs`, `DENY_FLAGS`, `ALLOW_PROPERTY_FLAGS`) described in Tasks 4 and 7–10
> below were subsequently removed. See
> [remove-args-input](2026-06-22-remove-args-input.md).
```

- [ ] **Step 6: Verify no stale references remain in shipping surfaces**

Run: `grep -rn "allowPropertyFlags\|ALLOW_PROPERTY_FLAGS\|validateArgs\|DENY_FLAGS" src/ README.md docker-compose.yml CLAUDE.md`
Expected: no matches.

- [ ] **Step 7: Final full verification**

Run: `bun test && bun run typecheck`
Expected: PASS (full suite green, typecheck clean).

- [ ] **Step 8: Commit**

```bash
git add README.md docker-compose.yml CLAUDE.md docs/superpowers/specs/2026-06-22-gradle-mcp-sandbox-design.md docs/superpowers/plans/2026-06-22-gradle-mcp-sandbox.md
git commit -m "docs: drop args/denylist references after removing the args input"
```

---

## Self-review notes

- **Spec coverage:** every component in the design table maps to a task — mcp.ts/tools.ts (Task 1), arg-policy.ts/config.ts (Task 2), all tests (Tasks 1-2), all docs (Task 3). The "PolicyError retained" requirement is honored in Task 2 Step 3.
- **Ordering:** Task 1 leaves `validateArgs`/`allowPropertyFlags` present-but-unused so the suite and typecheck stay green; Task 2 removes them only after the last consumer is gone. This avoids any intermediate broken state.
- **Verification reframing:** the old "denylist rejects a bad flag" guarantee is replaced by "a bad flag is not expressible" (the schema has no `args` property), per the spec's verification section.
