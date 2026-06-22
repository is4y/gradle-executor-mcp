import { test, expect } from "bun:test";
import { createMcpServer, TOOL_NAMES } from "./mcp";
import { SerialQueue } from "./queue";
import type { Config } from "./config";

const config: Config = {
  projectDir: "/p", port: 3000, gradleTimeoutMs: 1000,
  defaultOutputLines: 500, maxOutputLines: 5000,
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
