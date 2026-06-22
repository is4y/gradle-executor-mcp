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
