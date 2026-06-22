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
