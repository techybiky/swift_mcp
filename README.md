# swift-iso20022-mcp

An MCP (Model Context Protocol) server that gives any AI agent — Claude,
ChatGPT, Cursor, Windsurf, or any other MCP-compatible client, local or
remote — tools to validate SWIFT MT and ISO 20022 MX payment messages,
check BIC/IBAN correctness, and map between MT and MX formats, without the
agent hallucinating message-format rules.

Built from real SWIFT MT/ISO 20022 test-automation experience in banking and
payments (SWIFT MT/MX, ACH, SEPA, RTGS, FEDWIRE).

## Why this exists

Generic AI agents get SWIFT/ISO 20022 formatting wrong constantly — mandatory
fields, BIC shape, IBAN checksums, charges codes, and (as of the SWIFT
CBPR+ milestone in November 2026) structured vs. unstructured postal
addresses. This server gives an agent ground truth instead of a guess.

## Two transports — this is what makes it "universal"

MCP itself is the cross-vendor standard (Anthropic, OpenAI, Google, and
Microsoft all support it), but a server still has to expose the right
**transport** to be reachable by every kind of client:

| Transport | Entrypoint | Who connects this way |
|---|---|---|
| **stdio** | `src/index.js` | Local clients that spawn your process directly: Claude Desktop, Cursor, Windsurf, Cline |
| **Streamable HTTP** | `src/http-server.js` | Remote clients that connect over a URL: hosted connectors, web-based agents, anything that can't spawn a local process |

Same tools, same logic (`src/server-factory.js` is shared by both) — only
the wire format differs. Run whichever one matches where you want to be
reachable, or both at once on different machines.

## Tools exposed

| Tool | What it does |
|---|---|
| `validate_mt_message` | Validates an MT103 or MT202 message body: mandatory fields, date/currency/amount format, BIC shape, IBAN checksum, charges code |
| `validate_mx_message` | Validates a pacs.008/pacs.009 XML message: MsgId presence, currency shape, BICFI validity, IBAN checksum, unstructured-address warning |
| `validate_bic` | Structural BIC/SWIFT code check (8 or 11 chars) |
| `validate_iban` | IBAN shape + ISO 7064 mod-97 checksum |
| `convert_mt103_to_pacs008` | Maps MT103 fields to pacs.008 (customer credit transfer, has Dbtr/Cdtr) |
| `convert_mt202_to_pacs009` | Maps MT202 fields to pacs.009 (bank-to-bank transfer, has InstgAgt/InstdAgt BICs instead of customer parties) |
| `convert_pacs008_to_mt103` | Reverse direction: maps pacs.008 XML back to MT103 field tags, for coexistence-period systems that still expect MT |

## Install & test

```bash
cd swift-mcp
npm install
```

There are three ways to verify it works, in order of speed:

### 1. Unit tests — checks the logic in isolation

```bash
npm test
```

Runs 18 assertions against `swift-core.js` directly. No MCP protocol
involved — fastest signal that the validation/mapping logic is correct.

### 2. Manual protocol test — checks the stdio server

```bash
npm run test:manual
```

Spawns the actual stdio server and talks to it over real JSON-RPC (the same
transport Claude Desktop uses), calling all 7 tools with realistic data.

You can also inspect either transport interactively with the official MCP
Inspector:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

### 3. Manual test for the HTTP transport

```bash
npm run start:http
# in another terminal:
curl http://localhost:3000/health
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_bic","arguments":{"bic":"DEUTDEFF"}}}'
```

### 4. Live test in a real client

Add the config below for whichever client you're using, and try prompts like:

> "Validate this MT103: :20:REF123...\n:23B:CRED\n:32A:250115USD1000,00..."
> "Is DE89370400440532013000 a valid IBAN?"
> "Convert this MT202 to pacs.009: ..."

Watch for the tool-use block in the client's UI — that confirms it's calling
your server instead of guessing.

## Connect it — local clients (stdio)

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "swift-iso20022": {
      "command": "node",
      "args": ["/absolute/path/to/swift-mcp/src/index.js"]
    }
  }
}
```

Cursor, Windsurf, and Cline use the same shape in their own MCP config files
— just the `command`/`args` pair pointing at `src/index.js`.

## Connect it — remote clients (Streamable HTTP)

Run the HTTP server:

```bash
npm run start:http    # listens on PORT env var, default 3000
```

Deploy it anywhere Node.js runs — Render, Railway, Fly.io, a VPS — and point
any HTTP-based MCP client at:

```
https://your-deployed-host/mcp
```

### Securing the public endpoint

Set `MCP_API_KEY` in the deployment environment to require a bearer token on
every request. If it's unset, the endpoint stays open (fine for local/manual
testing, not for a public deploy):

```bash
MCP_API_KEY=your-secret-key npm run start:http
```

Clients must then send:

```
Authorization: Bearer your-secret-key
```

This is what lets a client that can't spawn a local process (a hosted
connector, a web app, a teammate who doesn't have your code checked out)
reach the same tools. It runs statelessly — every request gets a fresh
server instance, so there's no session state to lose on a restart, which
also makes it trivial to run on serverless platforms.

## Roadmap (next steps if you take this further)

- [x] MT202 -> pacs.009 mapping
- [x] Reverse MX -> MT mapping (pacs.008 -> MT103)
- [x] Streamable HTTP transport for remote/universal access
- [ ] Reverse pacs.009 -> MT202 mapping (currently only pacs.008 -> MT103 exists)
- [ ] Full XSD schema validation for MX messages (current MX check is structural, not schema-complete)
- [x] Auth (API key) on the HTTP endpoint via `MCP_API_KEY` — optional, off by default for local testing
- [ ] Publish to npm as `swift-iso20022-mcp` so it can be installed with `npx`
- [ ] Submit to the MCP server directory / registry once it has real usage
- [ ] Wire this same `src/swift-core.js` logic into Coexist as a shared package, so the SaaS UI and the MCP server never drift apart

## License

MIT
