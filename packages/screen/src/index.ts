#!/usr/bin/env node
// Modified by ibmi-agent-kit (2026): tool definitions moved to tools.ts; this file is only the standalone bootstrap.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register } from "./tools.js";

console.log = (...a: unknown[]) => console.error(...a); // stdout is the JSON-RPC channel
process.on("unhandledRejection", (r) => console.error("[ibm-i-5250] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[ibm-i-5250] uncaughtException:", e));

const mcp = new McpServer({ name: "ibm-i-5250", version: "0.2.0" }, { capabilities: { logging: {} } });
const engine = register(mcp);

async function main() {
  await mcp.connect(new StdioServerTransport());
  console.error("[ibm-i-5250] MCP server ready on stdio");
}

async function shutdown() {
  await engine.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown).on("SIGTERM", shutdown);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
