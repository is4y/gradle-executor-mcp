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
