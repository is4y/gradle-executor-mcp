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
    ["--system-prop", "x=y"], ["--init-script=/tmp/x"], ["--init-script:/tmp/x"],
  ]) {
    expect(() => validateArgs(bad, false)).toThrow(PolicyError);
  }
});

test("validateArgs gates -D/-P on allowPropertyFlags", () => {
  expect(() => validateArgs(["-Dfoo=bar"], false)).toThrow(PolicyError);
  expect(() => validateArgs(["-Pprod"], false)).toThrow(PolicyError);
  expect(validateArgs(["-Dfoo=bar"], true)).toEqual(["-Dfoo=bar"]);
  expect(validateArgs(["-Pprod"], true)).toEqual(["-Pprod"]);
});

test("validateArgs blocks attached short-option forms (bypass fix)", () => {
  // Each of these would bypass the exact-match check — they must now throw
  for (const bad of [
    ["-I/tmp/x"], ["-Iscript.gradle"],
    ["-bbuild.gradle"], ["-b/path/x"],
    ["-c/x"], ["-csettings.gradle"],
    ["-p/other"], ["-p/etc"],
  ]) {
    expect(() => validateArgs(bad, false)).toThrow(PolicyError);
  }
});

test("validateArgs still allows benign flags after bypass fix", () => {
  // These must NOT be blocked: different letter case or long-form
  const benign = [
    ["-i"], ["--info"], ["--stacktrace"], ["--no-daemon"], ["--offline"],
    ["--console=plain"], ["--build-cache"], ["--continue"], ["--parallel"], ["--profile"],
  ];
  for (const flags of benign) {
    expect(validateArgs(flags, false)).toEqual(flags);
  }
});
