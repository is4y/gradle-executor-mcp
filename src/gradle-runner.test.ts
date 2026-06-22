import { test, expect } from "bun:test";
import { resolveGradleCommand, runGradle } from "./gradle-runner";
import { resolve } from "node:path";

const FIXTURE = resolve(`${import.meta.dir}/../tests/fixtures/fake-wrapper`);

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
