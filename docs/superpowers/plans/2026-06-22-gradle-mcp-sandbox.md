# Gradle MCP Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a containerized MCP server (TypeScript on Bun) that lets agents run Gradle tasks/tests against one mounted project over streamable HTTP, with a no-shell argument-safety layer and container-level isolation.

**Architecture:** A small Bun/TypeScript MCP server registers three tools (`list_tasks`, `run_gradle_task`, `run_tests`). Each call is validated by a pure argument policy, serialized through a one-at-a-time queue, then executed by spawning the project's Gradle wrapper with an argv array (never a shell), with output tail-limited to a per-call line budget. The container runtime (non-root, read-only FS, dropped caps, restricted egress, resource limits) is the real security boundary.

**Tech Stack:** Bun (runtime, package manager, test runner), TypeScript, `@modelcontextprotocol/sdk` (MCP server + streamable-HTTP transport), `zod` (tool input schemas), Docker (delivery).

## Global Constraints

- **Runtime/PM/test runner:** Bun only. Tests run with `bun test`.
- **No shell, ever:** process execution uses `Bun.spawn` with an argv array; never `sh -c` / `{ shell: true }`.
- **One project per server:** working directory is pinned to `PROJECT_DIR` (env). No agent input selects paths.
- **Serialized builds:** at most one Gradle invocation runs at a time.
- **No app-level auth:** security comes from the container + argument policy.
- **Buffered output only:** no streaming, no XML test-report parsing.
- **Output unit is lines, tail-kept:** keep the last N lines; default `DEFAULT_OUTPUT_LINES`, hard ceiling `MAX_OUTPUT_LINES`.
- **`run_gradle_task` runs exactly one task.**
- **Dev shell has no JDK/Gradle:** unit tests must not require real Gradle. Real-Gradle tests skip when `gradle`/`./gradlew` is unavailable.
- **Source layout:** server modules under `src/`, tests as `*.test.ts` colocated under `src/` (Bun discovers them).

---

### Task 1: Project bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/smoke.test.ts`
- Modify: `.gitignore` (ensure `node_modules`, build output ignored — already ignores `node_modules`)

**Interfaces:**
- Consumes: nothing.
- Produces: a working `bun test` and `bun run` setup; dependencies `@modelcontextprotocol/sdk` and `zod` installed and pinned in `package.json`.

- [ ] **Step 1: Initialize package and install deps**

Run:
```bash
cd /workspaces/gradle-mcp
bun init -y
bun add @modelcontextprotocol/sdk zod
bun add -d typescript @types/bun
```

- [ ] **Step 2: Replace `package.json` scripts/metadata**

Overwrite the generated `package.json` so it reads (keep the dependency versions Bun just resolved):
```json
{
  "name": "gradle-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "module": "src/server.ts",
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  }
}
```
(Leave the actual resolved versions Bun wrote if they differ — do not downgrade.)

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write a smoke test**

`src/smoke.test.ts`:
```ts
import { test, expect } from "bun:test";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Run the smoke test**

Run: `bun test src/smoke.test.ts`
Expected: 1 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock tsconfig.json src/smoke.test.ts
git commit -m "chore: bootstrap Bun project with MCP SDK and zod"
```

---

### Task 2: Configuration module

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Config { projectDir: string; port: number; gradleTimeoutMs: number; defaultOutputLines: number; maxOutputLines: number; allowPropertyFlags: boolean }`
  - `function loadConfig(env: Record<string, string | undefined>): Config` — throws `Error` if `PROJECT_DIR` is missing/empty. Applies defaults: `port=3000`, `gradleTimeoutMs=600000`, `defaultOutputLines=500`, `maxOutputLines=5000`, `allowPropertyFlags=false`.

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { loadConfig } from "./config";

test("loadConfig applies defaults when only PROJECT_DIR set", () => {
  const cfg = loadConfig({ PROJECT_DIR: "/work/project" });
  expect(cfg.projectDir).toBe("/work/project");
  expect(cfg.port).toBe(3000);
  expect(cfg.gradleTimeoutMs).toBe(600000);
  expect(cfg.defaultOutputLines).toBe(500);
  expect(cfg.maxOutputLines).toBe(5000);
  expect(cfg.allowPropertyFlags).toBe(false);
});

test("loadConfig reads overrides and parses numbers", () => {
  const cfg = loadConfig({
    PROJECT_DIR: "/p", PORT: "8080", GRADLE_TIMEOUT_MS: "1000",
    DEFAULT_OUTPUT_LINES: "10", MAX_OUTPUT_LINES: "20", ALLOW_PROPERTY_FLAGS: "true",
  });
  expect(cfg.port).toBe(8080);
  expect(cfg.gradleTimeoutMs).toBe(1000);
  expect(cfg.defaultOutputLines).toBe(10);
  expect(cfg.maxOutputLines).toBe(20);
  expect(cfg.allowPropertyFlags).toBe(true);
});

test("loadConfig throws without PROJECT_DIR", () => {
  expect(() => loadConfig({})).toThrow("PROJECT_DIR");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Write minimal implementation**

`src/config.ts`:
```ts
export interface Config {
  projectDir: string;
  port: number;
  gradleTimeoutMs: number;
  defaultOutputLines: number;
  maxOutputLines: number;
  allowPropertyFlags: boolean;
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
    allowPropertyFlags: env.ALLOW_PROPERTY_FLAGS?.trim().toLowerCase() === "true",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config loader with env defaults"
```

---

### Task 3: Output tail-limiter

**Files:**
- Create: `src/output.ts`
- Create: `src/output.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function tailLines(text: string, maxLines: number): string` — returns the last `maxLines` lines; if any were dropped, prepends a line `… (N earlier lines omitted)`. Returns input unchanged when within budget. `maxLines <= 0` is treated as `1`.

- [ ] **Step 1: Write the failing test**

`src/output.test.ts`:
```ts
import { test, expect } from "bun:test";
import { tailLines } from "./output";

test("returns text unchanged when within budget", () => {
  expect(tailLines("a\nb\nc", 5)).toBe("a\nb\nc");
});

test("keeps the last N lines and adds an omission marker", () => {
  const out = tailLines("1\n2\n3\n4\n5", 2);
  expect(out).toBe("… (3 earlier lines omitted)\n4\n5");
});

test("empty input returns empty string", () => {
  expect(tailLines("", 10)).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/output.test.ts`
Expected: FAIL — cannot find module `./output`.

- [ ] **Step 3: Write minimal implementation**

`src/output.ts`:
```ts
export function tailLines(text: string, maxLines: number): string {
  if (text === "") return "";
  const limit = maxLines > 0 ? maxLines : 1;
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  const dropped = lines.length - limit;
  const kept = lines.slice(dropped);
  return `… (${dropped} earlier lines omitted)\n${kept.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/output.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output.ts src/output.test.ts
git commit -m "feat: add tail-keeping output limiter"
```

---

### Task 4: Argument safety policy (security-critical)

**Files:**
- Create: `src/arg-policy.ts`
- Create: `src/arg-policy.test.ts`

**Interfaces:**
- Consumes: `Config` (only `allowPropertyFlags`) from `src/config.ts`.
- Produces:
  - `class PolicyError extends Error {}`
  - `const TASK_RE = /^[A-Za-z0-9:._-]+$/`
  - `function validateTask(task: string): string` — throws `PolicyError` unless it matches `TASK_RE`; returns it.
  - `function validateTestFilters(tests: string[]): string[]` — each must match `^[A-Za-z0-9:._*$#-]+$` (allows JUnit method `Class#method`, package dots, wildcard `*`); returns a flat argv `["--tests", t1, "--tests", t2, ...]`.
  - `function validateArgs(args: string[], allowPropertyFlags: boolean): string[]` — rejects denylisted flags; returns the args unchanged if all allowed. Denylist (exact match OR `flag=...` / `flag:...` prefix): `--init-script`, `-I`, `--include-build`, `-b`, `--build-file`, `-c`, `--settings-file`, `-p`, `--project-dir`, `--system-prop`. When `allowPropertyFlags` is false, also reject any arg starting with `-D` or `-P`.

- [ ] **Step 1: Write the failing test**

`src/arg-policy.test.ts`:
```ts
import { test, expect } from "bun:test";
import { validateTask, validateTestFilters, validateArgs, PolicyError } from "./arg-policy";

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

test("validateArgs allows benign flags", () => {
  expect(validateArgs(["--stacktrace", "--no-daemon"], false)).toEqual(["--stacktrace", "--no-daemon"]);
});

test("validateArgs rejects code-execution / escape flags", () => {
  for (const bad of [
    ["--init-script", "/tmp/evil.gradle"], ["-I", "x"], ["--include-build", "../o"],
    ["-b", "evil.gradle"], ["--build-file", "x"], ["-c", "s.gradle"],
    ["--settings-file", "x"], ["-p", "/other"], ["--project-dir", "/other"],
    ["--system-prop", "x=y"], ["--init-script=/tmp/x"],
  ]) {
    expect(() => validateArgs(bad, false)).toThrow(PolicyError);
  }
});

test("validateArgs gates -D/-P on allowPropertyFlags", () => {
  expect(() => validateArgs(["-Dfoo=bar"], false)).toThrow(PolicyError);
  expect(() => validateArgs(["-Pprod"], false)).toThrow(PolicyError);
  expect(validateArgs(["-Dfoo=bar"], true)).toEqual(["-Dfoo=bar"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/arg-policy.test.ts`
Expected: FAIL — cannot find module `./arg-policy`.

- [ ] **Step 3: Write minimal implementation**

`src/arg-policy.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/arg-policy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/arg-policy.ts src/arg-policy.test.ts
git commit -m "feat: add argument safety policy with denylist"
```

---

### Task 5: Serialization queue

**Files:**
- Create: `src/queue.ts`
- Create: `src/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SerialQueue { run<T>(fn: () => Promise<T>): Promise<T> }` — runs submitted functions one at a time in submission order; a rejecting task does not block the next.

- [ ] **Step 1: Write the failing test**

`src/queue.test.ts`:
```ts
import { test, expect } from "bun:test";
import { SerialQueue } from "./queue";

test("runs tasks one at a time in order", async () => {
  const q = new SerialQueue();
  const events: string[] = [];
  const slow = q.run(async () => {
    events.push("start-a");
    await new Promise((r) => setTimeout(r, 30));
    events.push("end-a");
    return "a";
  });
  const fast = q.run(async () => {
    events.push("start-b");
    return "b";
  });
  expect(await slow).toBe("a");
  expect(await fast).toBe("b");
  expect(events).toEqual(["start-a", "end-a", "start-b"]);
});

test("a rejection does not block later tasks", async () => {
  const q = new SerialQueue();
  const failed = q.run(async () => { throw new Error("boom"); });
  const after = q.run(async () => "ok");
  await expect(failed).rejects.toThrow("boom");
  expect(await after).toBe("ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/queue.test.ts`
Expected: FAIL — cannot find module `./queue`.

- [ ] **Step 3: Write minimal implementation**

`src/queue.ts`:
```ts
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // keep the chain alive regardless of success/failure, without leaking rejections
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/queue.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat: add serial execution queue"
```

---

### Task 6: Gradle runner (the only process spawner)

**Files:**
- Create: `src/gradle-runner.ts`
- Create: `src/gradle-runner.test.ts`
- Create (test fixtures): `tests/fixtures/fake-wrapper/gradlew` (executable), `tests/fixtures/fake-wrapper/.gitkeep` not needed

**Interfaces:**
- Consumes: nothing (caller passes resolved values).
- Produces:
  - `interface GradleResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }`
  - `function resolveGradleCommand(projectDir: string): string` — returns the absolute path to `./gradlew` if it exists and is a file, else the string `"gradle"` (system Gradle). Logs to `console.error` when falling back.
  - `async function runGradle(projectDir: string, argv: string[], timeoutMs: number): Promise<GradleResult>` — spawns the resolved command with `argv` as arguments using `Bun.spawn` (no shell), `cwd = projectDir`, captures stdout/stderr, enforces `timeoutMs` (kills the process and sets `timedOut: true`, `exitCode: -1`).

- [ ] **Step 1: Create the fake wrapper fixture**

Create `tests/fixtures/fake-wrapper/gradlew` and make it executable:
```bash
mkdir -p tests/fixtures/fake-wrapper
cat > tests/fixtures/fake-wrapper/gradlew <<'EOF'
#!/usr/bin/env bash
# Fake gradlew for tests. Echoes args, supports a sleep + exit-code protocol.
echo "ARGS:$*"
echo "to stderr" 1>&2
for a in "$@"; do
  case "$a" in
    SLEEP=*) sleep "${a#SLEEP=}";;
    EXIT=*)  exit "${a#EXIT=}";;
  esac
done
exit 0
EOF
chmod +x tests/fixtures/fake-wrapper/gradlew
```

- [ ] **Step 2: Write the failing test**

`src/gradle-runner.test.ts`:
```ts
import { test, expect } from "bun:test";
import { resolveGradleCommand, runGradle } from "./gradle-runner";

const FIXTURE = `${import.meta.dir}/../tests/fixtures/fake-wrapper`;

test("resolveGradleCommand prefers ./gradlew when present", () => {
  expect(resolveGradleCommand(FIXTURE)).toBe(`${FIXTURE}/gradlew`);
});

test("resolveGradleCommand falls back to system gradle", () => {
  expect(resolveGradleCommand("/nonexistent/path")).toBe("gradle");
});

test("runGradle captures stdout, stderr and exit code", async () => {
  const r = await runGradle(FIXTURE, ["help"], 5000);
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stdout).toContain("ARGS:help");
  expect(r.stderr).toContain("to stderr");
});

test("runGradle reports non-zero exit codes", async () => {
  const r = await runGradle(FIXTURE, ["EXIT=7"], 5000);
  expect(r.exitCode).toBe(7);
  expect(r.timedOut).toBe(false);
});

test("runGradle kills and flags a timed-out build", async () => {
  const r = await runGradle(FIXTURE, ["SLEEP=5"], 200);
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(-1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/gradle-runner.test.ts`
Expected: FAIL — cannot find module `./gradle-runner`.

- [ ] **Step 4: Write minimal implementation**

`src/gradle-runner.ts`:
```ts
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
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { exitCode: timedOut ? -1 : exitCode, stdout, stderr, timedOut };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/gradle-runner.test.ts`
Expected: PASS (5 tests). (Requires `bash`, which is present in the dev shell.)

- [ ] **Step 6: Commit**

```bash
git add src/gradle-runner.ts src/gradle-runner.test.ts tests/fixtures/fake-wrapper/gradlew
git commit -m "feat: add no-shell Gradle runner with timeout"
```

---

### Task 7: Tools (wire policy + queue + runner + output)

**Files:**
- Create: `src/tools.ts`
- Create: `src/tools.test.ts`

**Interfaces:**
- Consumes: `Config` (config.ts), `validateTask`/`validateArgs`/`validateTestFilters`/`PolicyError` (arg-policy.ts), `SerialQueue` (queue.ts), `runGradle`/`GradleResult` (gradle-runner.ts), `tailLines` (output.ts).
- Produces:
  - `interface ToolDeps { config: Config; queue: SerialQueue; run: typeof runGradle }` — `run` is injectable so tests can pass a fake.
  - `interface ToolResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }`
  - `function buildArgvForTask(task: string, args: string[], allowPropertyFlags: boolean): string[]`
  - `function buildArgvForTests(tests: string[], args: string[], allowPropertyFlags: boolean): string[]`
  - `async function listTasks(deps: ToolDeps): Promise<ToolResult>`
  - `async function runGradleTask(deps: ToolDeps, input: { task: string; args?: string[]; maxOutputLines?: number }): Promise<ToolResult>`
  - `async function runTests(deps: ToolDeps, input: { tests?: string[]; args?: string[]; maxOutputLines?: number }): Promise<ToolResult>`
  - Each clamps output to `min(maxOutputLines ?? config.defaultOutputLines, config.maxOutputLines)` via `tailLines`, runs inside `queue.run`, and validates before executing. `PolicyError` propagates (no execution).

- [ ] **Step 1: Write the failing test**

`src/tools.test.ts`:
```ts
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
  expect(buildArgvForTask("build", ["--stacktrace"], false)).toEqual(["build", "--stacktrace"]);
});

test("buildArgvForTask rejects bad task before building", () => {
  expect(() => buildArgvForTask("a; rm", [], false)).toThrow(PolicyError);
});

test("buildArgvForTests prepends 'test' and --tests filters", () => {
  expect(buildArgvForTests(["com.x.T"], ["--info"], false))
    .toEqual(["test", "--tests", "com.x.T", "--info"]);
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

test("policy violation rejects without executing", async () => {
  const captured: string[][] = [];
  const deps = { config, queue: new SerialQueue(), run: fakeRun(captured) };
  await expect(runGradleTask(deps, { task: "ok", args: ["--init-script", "x"] }))
    .rejects.toThrow(PolicyError);
  expect(captured.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tools.test.ts`
Expected: FAIL — cannot find module `./tools`.

- [ ] **Step 3: Write minimal implementation**

`src/tools.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tools.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat: wire tools (policy + queue + runner + output)"
```

---

### Task 8: MCP server + streamable-HTTP transport

**Files:**
- Create: `src/mcp.ts`
- Create: `src/mcp.test.ts`
- Create: `src/server.ts`

**Interfaces:**
- Consumes: `ToolDeps`/`listTasks`/`runGradleTask`/`runTests` (tools.ts), `loadConfig` (config.ts), `SerialQueue` (queue.ts), `runGradle` (gradle-runner.ts), `PolicyError` (arg-policy.ts).
- Produces:
  - `const TOOL_NAMES = ["list_tasks", "run_gradle_task", "run_tests"] as const`
  - `function createMcpServer(deps: ToolDeps): McpServer` — registers the three tools with zod input schemas; each handler calls the matching tools.ts function and returns `{ content: [{ type: "text", text: JSON.stringify(result) }], isError: result.exitCode !== 0 }`; `PolicyError` is caught and returned as `{ content: [...], isError: true }` with the message.
  - `src/server.ts` — entrypoint: `loadConfig(process.env)`, build `ToolDeps`, `createMcpServer`, start a `node:http` server using `StreamableHTTPServerTransport` in stateless mode on `config.port`.

- [ ] **Step 1: Write the failing test (tool registration)**

`src/mcp.test.ts`:
```ts
import { test, expect } from "bun:test";
import { createMcpServer, TOOL_NAMES } from "./mcp";
import { SerialQueue } from "./queue";
import type { Config } from "./config";

const config: Config = {
  projectDir: "/p", port: 3000, gradleTimeoutMs: 1000,
  defaultOutputLines: 500, maxOutputLines: 5000, allowPropertyFlags: false,
};

test("registers exactly the three expected tools", () => {
  const deps = {
    config, queue: new SerialQueue(),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  };
  const server = createMcpServer(deps);
  // McpServer keeps registered tools on an internal record; assert names present.
  const registered = Object.keys((server as any)._registeredTools ?? {});
  for (const name of TOOL_NAMES) expect(registered).toContain(name);
});
```

> Note: `_registeredTools` is an internal of the current SDK. If the installed SDK exposes a different shape, adjust this assertion to whatever the SDK provides for listing tools (e.g. call the server's list handler). The goal of the test is only: "all three tool names are registered."

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mcp.test.ts`
Expected: FAIL — cannot find module `./mcp`.

- [ ] **Step 3: Write minimal implementation**

`src/mcp.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps, ToolResult } from "./tools";
import { listTasks, runGradleTask, runTests } from "./tools";
import { PolicyError } from "./arg-policy";

export const TOOL_NAMES = ["list_tasks", "run_gradle_task", "run_tests"] as const;

function ok(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    isError: result.exitCode !== 0,
  };
}

function policyError(err: unknown) {
  const message = err instanceof PolicyError ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "gradle-mcp", version: "0.1.0" });

  server.registerTool(
    "list_tasks",
    { description: "List the Gradle tasks available in the mounted project.", inputSchema: {} },
    async () => ok(await listTasks(deps)),
  );

  server.registerTool(
    "run_gradle_task",
    {
      description: "Run a single Gradle task in the mounted project.",
      inputSchema: {
        task: z.string().describe("Exactly one Gradle task name, e.g. 'build'"),
        args: z.array(z.string()).optional().describe("Extra Gradle flags (denylisted flags are rejected)"),
        maxOutputLines: z.number().int().positive().optional().describe("Tail this many output lines"),
      },
    },
    async (input) => {
      try {
        return ok(await runGradleTask(deps, input));
      } catch (err) {
        return policyError(err);
      }
    },
  );

  server.registerTool(
    "run_tests",
    {
      description: "Run the 'test' task, optionally filtered with --tests patterns.",
      inputSchema: {
        tests: z.array(z.string()).optional().describe("JUnit test filters, e.g. 'com.x.MyTest'"),
        args: z.array(z.string()).optional().describe("Extra Gradle flags (denylisted flags are rejected)"),
        maxOutputLines: z.number().int().positive().optional().describe("Tail this many output lines"),
      },
    },
    async (input) => {
      try {
        return ok(await runTests(deps, input));
      } catch (err) {
        return policyError(err);
      }
    },
  );

  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mcp.test.ts`
Expected: PASS (1 test). If the SDK internal shape differs, adjust the assertion per the Step 1 note, then re-run.

- [ ] **Step 5: Write the HTTP entrypoint**

`src/server.ts`:
```ts
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config";
import { SerialQueue } from "./queue";
import { runGradle } from "./gradle-runner";
import { createMcpServer } from "./mcp";

const config = loadConfig(process.env);
const deps = { config, queue: new SerialQueue(), run: runGradle };

const httpServer = createServer(async (req, res) => {
  // Stateless: a fresh transport + server per request avoids cross-request state.
  const server = createMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);

  // Collect the request body for the transport.
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

  await transport.handleRequest(req, res, body);
});

httpServer.listen(config.port, () => {
  console.error(`gradle-mcp listening on :${config.port} for project ${config.projectDir}`);
});
```

> Note: `deps` (queue) is shared across requests so builds stay serialized server-wide; only the MCP `server`/`transport` objects are per-request. Verify the `handleRequest(req, res, body)` signature against the installed SDK version; adjust if it differs.

- [ ] **Step 6: Manual HTTP smoke check**

Run (requires `PROJECT_DIR` set; use the fixture):
```bash
PROJECT_DIR="$PWD/tests/fixtures/fake-wrapper" PORT=3111 bun run src/server.ts &
SERVER_PID=$!
sleep 1
curl -sS -X POST http://localhost:3111/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
kill $SERVER_PID
```
Expected: a JSON-RPC result containing `"serverInfo"` with `"name":"gradle-mcp"` (response may be an SSE `data:` line; that is fine). If the response shape differs, reconcile `src/server.ts` with the installed SDK's streamable-HTTP example, then re-run.

- [ ] **Step 7: Commit**

```bash
git add src/mcp.ts src/mcp.test.ts src/server.ts
git commit -m "feat: add MCP server with streamable-HTTP transport"
```

---

### Task 9: Real-Gradle integration test (skips without Gradle)

**Files:**
- Create: `tests/fixtures/real-project/build.gradle`
- Create: `tests/fixtures/real-project/settings.gradle`
- Create: `src/integration.test.ts`

**Interfaces:**
- Consumes: `runGradleTask`/`listTasks` (tools.ts), `loadConfig`, `SerialQueue`, `runGradle`.
- Produces: end-to-end coverage that real Gradle is driven correctly. Tests **skip** when no `gradle`/`./gradlew` is available (dev shell has none), so the suite stays green locally and these run in the container/CI.

- [ ] **Step 1: Create a tiny real Gradle project (no plugins, no network)**

`tests/fixtures/real-project/settings.gradle`:
```groovy
rootProject.name = 'real-project'
```

`tests/fixtures/real-project/build.gradle`:
```groovy
tasks.register('succeed') {
    doLast { println 'SUCCEED_OK' }
}
tasks.register('fail') {
    doLast { throw new GradleException('intentional failure') }
}
```

- [ ] **Step 2: Write the integration test (guarded by a Gradle check)**

`src/integration.test.ts`:
```ts
import { test, expect } from "bun:test";
import { which } from "bun";
import { runGradleTask, listTasks } from "./tools";
import { SerialQueue } from "./queue";
import { runGradle } from "./gradle-runner";
import type { Config } from "./config";

const projectDir = `${import.meta.dir}/../tests/fixtures/real-project`;
const hasGradle = which("gradle") !== null;

const config: Config = {
  projectDir, port: 3000, gradleTimeoutMs: 120000,
  defaultOutputLines: 1000, maxOutputLines: 5000, allowPropertyFlags: false,
};
const deps = { config, queue: new SerialQueue(), run: runGradle };

test.if(hasGradle)("list_tasks returns the project tasks", async () => {
  const r = await listTasks(deps);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("succeed");
});

test.if(hasGradle)("a passing task exits 0", async () => {
  const r = await runGradleTask(deps, { task: "succeed" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("SUCCEED_OK");
});

test.if(hasGradle)("a failing task exits non-zero with output", async () => {
  const r = await runGradleTask(deps, { task: "fail" });
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("intentional failure");
});

test("denied flag is rejected without executing (no Gradle needed)", async () => {
  await expect(runGradleTask(deps, { task: "succeed", args: ["--init-script", "/tmp/x"] }))
    .rejects.toThrow();
});
```

> `test.if(cond)` runs the test only when `cond` is true; in the dev shell (no Gradle) the three Gradle tests are skipped and the denied-flag test still runs.

- [ ] **Step 3: Run the suite**

Run: `bun test src/integration.test.ts`
Expected (dev shell, no Gradle): 3 skipped, 1 pass. (In the container with Gradle: 4 pass.)

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/real-project/settings.gradle tests/fixtures/real-project/build.gradle src/integration.test.ts
git commit -m "test: add real-Gradle integration tests (skip without Gradle)"
```

---

### Task 10: Container delivery + docs

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished server (`src/server.ts`), `package.json`.
- Produces: a runnable hardened container and operator documentation.

- [ ] **Step 1: Write `.dockerignore`**

```
.git
.devenv
node_modules
docs
tests/fixtures
```

- [ ] **Step 2: Write the `Dockerfile`**

`Dockerfile` (JDK for Gradle + Bun for the server; non-root):
```dockerfile
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
```

- [ ] **Step 3: Write `docker-compose.yml` showing the hardening**

`docker-compose.yml`:
```yaml
services:
  gradle-mcp:
    build: .
    ports:
      - "127.0.0.1:3000:3000"   # bind to loopback only; rely on network isolation
    environment:
      PROJECT_DIR: /project
      PORT: "3000"
      GRADLE_TIMEOUT_MS: "600000"
      DEFAULT_OUTPUT_LINES: "500"
      MAX_OUTPUT_LINES: "5000"
      # ALLOW_PROPERTY_FLAGS: "true"   # opt-in to -D/-P
      # Egress control via Gradle proxy (point at an allowlisting proxy):
      # JAVA_OPTS: "-Dhttps.proxyHost=proxy -Dhttps.proxyPort=3128"
    volumes:
      - ./your-gradle-project:/project:rw      # the mounted project
      - gradle-cache:/home/bun/.gradle         # persist Gradle caches
    # --- hardening ---
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 512
    mem_limit: 4g
    cpus: "2.0"

volumes:
  gradle-cache:
```

> Note: with `read_only: true`, the project mount and the Gradle cache volume remain writable; `/tmp` is provided via tmpfs. If a build needs more writable scratch space, add it as an explicit volume/tmpfs — do not drop `read_only`.

- [ ] **Step 4: Write `README.md`**

`README.md` must cover, with real commands:
```markdown
# gradle-mcp

A containerized MCP server that lets agents run Gradle tasks/tests against one
mounted project over streamable HTTP, with a no-shell argument-safety layer.

## Tools
- `list_tasks()` — list the project's Gradle tasks.
- `run_gradle_task({ task, args?, maxOutputLines? })` — run one task.
- `run_tests({ tests?, args?, maxOutputLines? })` — run the `test` task, optional `--tests` filters.

All output is buffered, returned as `{ exitCode, stdout, stderr, timedOut }`,
and tail-limited to `maxOutputLines` (default 500, ceiling 5000).

## Configuration (env)
| Var | Default | Meaning |
|-----|---------|---------|
| `PROJECT_DIR` | (required) | Absolute path to the mounted project |
| `PORT` | 3000 | HTTP port |
| `GRADLE_TIMEOUT_MS` | 600000 | Per-build timeout (build killed on expiry) |
| `DEFAULT_OUTPUT_LINES` | 500 | Output lines when a call omits `maxOutputLines` |
| `MAX_OUTPUT_LINES` | 5000 | Hard ceiling for output lines |
| `ALLOW_PROPERTY_FLAGS` | false | Permit `-D`/`-P` flags |

## Run
\`\`\`bash
# edit docker-compose.yml: point the ./your-gradle-project volume at your project
docker compose up --build
\`\`\`
The MCP endpoint is then at `http://127.0.0.1:3000/`.

## Connecting an agent
Configure your MCP client with a streamable-HTTP server URL of `http://127.0.0.1:3000/`.
There is no app-level auth — only expose the port on a trusted/loopback network.

## Security model
- **No shell:** Gradle is spawned with an argv array; classic command injection is impossible.
- **Argument denylist:** `--init-script`, `-I`, `--include-build`, `-b/--build-file`,
  `-c/--settings-file`, `-p/--project-dir`, `--system-prop`, and (by default) `-D`/`-P` are rejected.
- **The container is the real boundary:** non-root, read-only FS, `cap_drop: ALL`,
  `no-new-privileges`, pids/mem/cpu limits, timeout, and restricted egress (Gradle proxy).
- Builds run arbitrary code by design — never point this at an untrusted project without the container hardening.

## Development
\`\`\`bash
bun install
bun test          # unit + integration (Gradle tests skip if no gradle on PATH)
bun run start     # needs PROJECT_DIR set
\`\`\`
```

- [ ] **Step 5: Update `CLAUDE.md`**

Replace the "Status" section's "no application code" claim and record the real commands under "Common commands":
```markdown
- `bun install` — install dependencies.
- `bun test` — run the full test suite. Run one file: `bun test src/arg-policy.test.ts`. Gradle integration tests skip when no `gradle` is on PATH.
- `bun run start` — start the MCP server (requires `PROJECT_DIR`).
- `docker compose up --build` — run the hardened container (edit the project volume first).
```
Also add a one-line pointer to the design spec and this plan under "Key files".

- [ ] **Step 6: Verify the build and full suite**

Run:
```bash
bun run typecheck
bun test
```
Expected: typecheck clean; all tests pass (Gradle integration tests skipped in the dev shell).

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore README.md CLAUDE.md
git commit -m "feat: add container delivery and documentation"
```

---

## Self-Review

**Spec coverage:**
- Purpose / mounted project / one-project-per-container → Tasks 6–9, compose mount. ✓
- Tools `list_tasks`/`run_gradle_task` (single task)/`run_tests` → Task 7, 8. ✓
- Streamable HTTP transport, no auth → Task 8, compose loopback bind. ✓
- Serialized builds → Task 5 (queue), shared in Task 8. ✓
- Buffered output, no XML parsing → Task 7. ✓
- Per-call `maxOutputLines`, lines unit, default + ceiling → Tasks 2, 3, 7. ✓
- No shell / argv exec → Task 6. ✓
- Argument denylist + task regex + test-filter validation → Task 4. ✓
- Path pinning to `PROJECT_DIR` → Tasks 6, 7 (cwd), config required. ✓
- Container hardening (non-root, read-only, cap-drop, limits, egress/proxy, timeout) → Tasks 6 (timeout), 10. ✓
- Error handling (policy → error no-exec; non-zero exit → normal result; timeout → error) → Tasks 7, 8. ✓
- Testing (arg-policy, output, integration with passing/failing/denied) → Tasks 3, 4, 9. ✓
- Delivery (package.json, Dockerfile, compose, README, CLAUDE.md) → Tasks 1, 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; SDK-internal notes give a concrete fallback action rather than leaving work undefined.

**Type consistency:** `GradleResult`/`ToolResult` fields (`exitCode`, `stdout`, `stderr`, `timedOut`) are consistent across Tasks 6–8. `ToolDeps.run` matches `runGradle`'s signature `(projectDir, argv, timeoutMs)`. Tool names `list_tasks`/`run_gradle_task`/`run_tests` consistent across Tasks 7–10. `tailLines(text, maxLines)`, `validateTask`/`validateArgs`/`validateTestFilters` signatures consistent.
