// test/manual-client.js
// Spins up the actual MCP server as a child process and talks to it over
// real stdio JSON-RPC — the same way Claude Desktop or any MCP client would.
// Use this to sanity-check the server after any change, without needing
// Claude Desktop installed.

const { spawn } = require("child_process");
const path = require("path");

const proc = spawn("node", [path.join(__dirname, "../src/index.js")]);
let buf = "";
let id = 0;

proc.stdout.on("data", (d) => { buf += d.toString(); });
proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function send(method, params) {
  id += 1;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

function callTool(name, args) {
  return send("tools/call", { name, arguments: args });
}

const calls = [
  ["validate_bic", { bic: "DEUTDEFF" }],
  ["validate_iban", { iban: "GB29NWBK60161331926819" }],
  [
    "validate_mt_message",
    {
      message_type: "MT103",
      raw_message:
        ":20:REF123456789\n:23B:CRED\n:32A:250115USD1000,00\n:50K:/GB29NWBK60161331926819\nJOHN DOE\n:59:/DE89370400440532013000\nJANE SMITH\n:71A:SHA",
    },
  ],
  [
    "convert_mt103_to_pacs008",
    {
      raw_message:
        ":20:REF123456789\n:23B:CRED\n:32A:250115USD1000,00\n:50K:/GB29NWBK60161331926819\nJOHN DOE\n:59:/DE89370400440532013000\nJANE SMITH\n:71A:SHA",
    },
  ],
  [
    "convert_mt202_to_pacs009",
    { raw_message: ":20:REF987654321\n:21:RELREF001\n:32A:250201GBP50000,00\n:52A:CHASUS33\n:58A:DEUTDEFF" },
  ],
  [
    "validate_mx_message",
    {
      message_type: "pacs.008",
      xml: "<Document><GrpHdr><MsgId>M1</MsgId></GrpHdr><PstlAdr><AdrLine>123 Main St</AdrLine></PstlAdr></Document>",
    },
  ],
  [
    "convert_pacs008_to_mt103",
    {
      xml:
        '<Document><GrpHdr><MsgId>M999</MsgId></GrpHdr><IntrBkSttlmDt>2025-03-10</IntrBkSttlmDt><IntrBkSttlmAmt Ccy="EUR">2500.00</IntrBkSttlmAmt><ChrgBr>SHAR</ChrgBr><Dbtr><Nm>ACME CORP</Nm></Dbtr><CdtrAcct><IBAN>DE89370400440532013000</IBAN></CdtrAcct></Document>',
    },
  ],
];

send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "manual-test-client", version: "1.0" },
});

setTimeout(() => {
  send("notifications/initialized");
  calls.forEach(([name, args]) => callTool(name, args));
}, 300);

setTimeout(() => {
  const lines = buf.trim().split("\n").filter(Boolean);
  console.log(`\nReceived ${lines.length} responses:\n`);
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.result?.tools) {
      console.log(`[tools/list] ${msg.result.tools.length} tools registered`);
    } else if (msg.result?.content) {
      console.log(`[response id ${msg.id}]`, msg.result.content[0].text.replace(/\n/g, " "));
    } else if (msg.result?.serverInfo) {
      console.log(`[initialize] connected to ${msg.result.serverInfo.name} v${msg.result.serverInfo.version}`);
    }
  }
  proc.kill();
  process.exit(0);
}, 1500);
