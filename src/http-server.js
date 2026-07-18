#!/usr/bin/env node
// SWIFT / ISO 20022 MCP Server — Streamable HTTP entrypoint.
// Used by remote clients that connect over a URL instead of spawning a local
// process: hosted Claude connectors, web-based agents, or any MCP client
// that talks HTTP. Deploy this anywhere Node.js runs (Render, Fly.io,
// Railway, a VPS, etc.) and point clients at https://your-host/mcp.
//
// Runs in stateless mode: every request gets a fresh server + transport
// instance, so there's no session state to manage or lose on restart. This
// is the simplest and most portable mode for a public MCP endpoint. If you
// later need multi-request sessions (streaming progress across calls),
// switch sessionIdGenerator below to a real generator and keep transports
// keyed by session ID.

const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createServer } = require("./server-factory.js");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking needed
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support the GET (server-initiated stream) or
// DELETE (session teardown) parts of the spec — respond clearly instead of
// hanging, since some clients probe these before falling back to POST-only.
app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this server runs stateless, POST-only." },
    id: null,
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", server: "swift-iso20022-validator" }));

app.listen(PORT, () => {
  console.error(`SWIFT/ISO20022 MCP server (Streamable HTTP) listening on port ${PORT}`);
  console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
