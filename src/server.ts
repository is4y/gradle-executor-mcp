import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config";
import { SerialQueue } from "./queue";
import { runGradle } from "./gradle-runner";
import { createMcpServer } from "./mcp";

const config = loadConfig(process.env);
const deps = { config, queue: new SerialQueue(), run: runGradle };

const httpServer = createServer(async (req, res) => {
  // Stateless: a fresh transport + server per request avoids cross-request state.
  // deps (queue) is shared across requests so builds stay serialized server-wide.
  const server = createMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);

  // Collect the request body for the transport.
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

  await transport.handleRequest(req, res, body);
});

httpServer.listen(config.port, () => {
  console.error(`gradle-mcp listening on :${config.port} for project ${config.projectDir}`);
});
