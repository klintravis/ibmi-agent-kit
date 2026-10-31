#!/usr/bin/env node
// Modified by ibmi-agent-kit (2026): standalone bootstrap only; the tool definitions moved to tools.ts.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register } from "./tools.js";

// --- runtime ---
console.log = (...a: unknown[]) => console.error(...a); // stdout is the JSON-RPC channel
process.on("unhandledRejection", (r) => console.error("[ibm-i-source] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[ibm-i-source] uncaughtException:", e));

const mcp = new McpServer({ name: "ibm-i-source", version: "0.7.0" }, { capabilities: { logging: {} } });
const tools = register(mcp);

// --- bootstrap ---
async function main() {
  await mcp.connect(new StdioServerTransport());
  console.error("[ibm-i-source] MCP server ready on stdio");
}
async function shutdown() {
  await tools.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
main().catch((e) => { console.error(e); process.exit(1); });
