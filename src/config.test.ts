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
