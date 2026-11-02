#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { credentialCli } from "./credential-cli.js";
import { policyCli } from "./policy-cli.js";
import { createServer, onceShutdown, type KitServer } from "./server.js";
import { setupCli } from "./setup-cli.js";

// `policy test|replay` runs offline, `setup` and `credential` ask at the terminal, all printing to
// stdout; anything else serves MCP on stdio.
if (process.argv[2] === "policy") process.exitCode = await policyCli(process.argv.slice(3));
else if (process.argv[2] === "credential") {
  process.exitCode = await credentialCli(process.argv.slice(3), {
    input: process.stdin,
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  });
  setTimeout(() => process.exit(), 1000).unref();
} else if (process.argv[2] === "setup") {
  process.exitCode = await setupCli(process.argv.slice(3));
  setTimeout(() => process.exit(), 1000).unref(); // fires only if a test connection left a handle open
} else serve();

function serve(): void {
  // stdout is the JSON-RPC channel; every console writer that targets it goes to stderr instead.
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  process.on("unhandledRejection", (r) => console.error("[ibmi-agent-kit] unhandledRejection:", r));
  process.on("uncaughtException", (e) => console.error("[ibmi-agent-kit] uncaughtException:", e));

  let kit: KitServer;
  try {
    kit = createServer();
  } catch (e) {
    // A tool name registered twice: the SDK's message names it.
    console.error(`[ibmi-agent-kit] startup failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Exit from the write callback, so the last line reaches a piped stderr before the process ends.
  const stop = onceShutdown(kit.engines, (code) => {
    process.stderr.write("[ibmi-agent-kit] shutdown complete\n", () => process.exit(code));
  });

  // Windows delivers no SIGTERM when a parent ends the child, and the SDK's stdio transport does
  // not close when stdin ends, so stdin end is a trigger of its own.
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.stdin.on("end", () => void stop("stdin end"));

  const transport = new StdioServerTransport();
  // Set before connect: the SDK wraps an existing onclose instead of replacing it.
  transport.onclose = () => void stop("transport closed");

  kit.mcp
    .connect(transport)
    .then(() => console.error("[ibmi-agent-kit] MCP server ready on stdio"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
