// src/server-factory.js
// Builds a fresh McpServer instance with all tools registered. Shared by both
// transports (stdio for local clients, Streamable HTTP for remote clients)
// so the tool definitions only exist in one place and never drift between
// the two entrypoints.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const {
  isValidBIC,
  isValidIBAN,
  validateMTMessage,
  validateMXMessage,
  mapMT103ToPacs008,
  mapMT202ToPacs009,
  mapPacs008ToMT103,
  MT_RULES,
} = require("./swift-core.js");

function createServer() {
  const server = new McpServer({
    name: "swift-iso20022-validator",
    version: "0.1.0",
  });

  server.registerTool(
    "validate_mt_message",
    {
      title: "Validate SWIFT MT message",
      description:
        "Validates a SWIFT MT103 (customer credit transfer) or MT202 (FI transfer) message body against " +
        "mandatory-field rules, field-format rules (dates, currency, BIC, charges code), and IBAN checksums. " +
        "Use this before submitting or forwarding an MT message, or when an agent needs to check a message " +
        "it generated or received is well-formed.",
      inputSchema: {
        message_type: z.enum(Object.keys(MT_RULES)).describe("The MT message type, e.g. MT103 or MT202"),
        raw_message: z
          .string()
          .describe("The raw MT message body with SWIFT field tags, e.g. ':20:REF123\\n:23B:CRED\\n:32A:...'"),
      },
    },
    async ({ message_type, raw_message }) => {
      const result = validateMTMessage(message_type, raw_message);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.valid,
      };
    }
  );

  server.registerTool(
    "validate_mx_message",
    {
      title: "Validate ISO 20022 MX message",
      description:
        "Validates an ISO 20022 MX message (pacs.008 or pacs.009 XML) for structural issues: missing MsgId, " +
        "malformed currency codes, invalid BICFI values, invalid IBAN checksums, and unstructured-address usage " +
        "flagged against SWIFT's November 2026 CBPR+ structured-address requirement. Not a full XSD validator — " +
        "use for a fast pre-check before schema validation.",
      inputSchema: {
        message_type: z.enum(["pacs.008", "pacs.009"]).describe("The ISO 20022 message type"),
        xml: z.string().describe("The raw MX message as XML text"),
      },
    },
    async ({ message_type, xml }) => {
      const result = validateMXMessage(message_type, xml);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.valid,
      };
    }
  );

  server.registerTool(
    "validate_bic",
    {
      title: "Validate BIC/SWIFT code",
      description:
        "Checks whether a string is a structurally valid BIC (8 or 11 characters: 4-letter bank code, " +
        "2-letter country code, 2-char location code, optional 3-char branch code).",
      inputSchema: {
        bic: z.string().describe("The BIC/SWIFT code to validate, e.g. DEUTDEFF or DEUTDEFF500"),
      },
    },
    async ({ bic }) => {
      const valid = isValidBIC(bic);
      return {
        content: [{ type: "text", text: JSON.stringify({ bic, valid }, null, 2) }],
        isError: !valid,
      };
    }
  );

  server.registerTool(
    "validate_iban",
    {
      title: "Validate IBAN",
      description: "Checks whether a string is a structurally valid IBAN and passes the ISO 7064 mod-97 checksum.",
      inputSchema: {
        iban: z.string().describe("The IBAN to validate, e.g. GB29NWBK60161331926819"),
      },
    },
    async ({ iban }) => {
      const valid = isValidIBAN(iban);
      return {
        content: [{ type: "text", text: JSON.stringify({ iban, valid }, null, 2) }],
        isError: !valid,
      };
    }
  );

  server.registerTool(
    "convert_mt103_to_pacs008",
    {
      title: "Convert MT103 to pacs.008 fields",
      description:
        "Parses a SWIFT MT103 message and maps its fields to the equivalent ISO 20022 pacs.008 fields " +
        "(MsgId, IntrBkSttlmDt, IntrBkSttlmAmt, Ccy, ChrgBr, Dbtr/Cdtr name and account). Returns a simplified " +
        "field map plus notes on anything that couldn't be confidently mapped — not a full XML generator, " +
        "intended for agents that need a quick MT-to-MX field bridge.",
      inputSchema: {
        raw_message: z.string().describe("The raw MT103 message body"),
      },
    },
    async ({ raw_message }) => {
      const result = mapMT103ToPacs008(raw_message);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "convert_mt202_to_pacs009",
    {
      title: "Convert MT202 to pacs.009 fields",
      description:
        "Parses a SWIFT MT202 (General Financial Institution Transfer) message and maps its fields to the " +
        "equivalent ISO 20022 pacs.009 fields (MsgId, EndToEndId, IntrBkSttlmDt, IntrBkSttlmAmt, Ccy, " +
        "InstgAgt/InstdAgt/IntrmyAgt1 BICs). Unlike MT103, MT202 moves money bank-to-bank so there is no " +
        "customer-level Dbtr/Cdtr — only institution BICs. Returns notes on anything not confidently mapped.",
      inputSchema: {
        raw_message: z.string().describe("The raw MT202 message body"),
      },
    },
    async ({ raw_message }) => {
      const result = mapMT202ToPacs009(raw_message);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "convert_pacs008_to_mt103",
    {
      title: "Convert pacs.008 to MT103 fields (reverse mapping)",
      description:
        "Parses an ISO 20022 pacs.008 XML message and maps its fields back to SWIFT MT103 field tags " +
        "(:20:, :23B:, :32A:, :50K:, :59:, :71A:). Useful during the SWIFT MT/MX coexistence period when a " +
        "downstream system still expects MT format. Deliberately conservative — only maps fields it can " +
        "extract with confidence and flags the rest in the notes array rather than guessing.",
      inputSchema: {
        xml: z.string().describe("The raw pacs.008 message as XML text"),
      },
    },
    async ({ xml }) => {
      const result = mapPacs008ToMT103(xml);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

module.exports = { createServer };
