#!/usr/bin/env node
// SWIFT / ISO 20022 MCP Server — stdio entrypoint.
// Used by local clients that spawn this process directly: Claude Desktop,
// Cursor, Windsurf, Cline, etc. For remote/hosted access over HTTP, see
// http-server.js instead.

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = require("./server-factory.js");

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SWIFT/ISO20022 MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
