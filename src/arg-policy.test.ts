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
