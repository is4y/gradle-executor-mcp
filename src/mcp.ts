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
