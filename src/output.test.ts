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
