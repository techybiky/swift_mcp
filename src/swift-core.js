// swift-core.js
// Core SWIFT MT (MT103/MT202) and ISO 20022 MX (pacs.008/pacs.009) validation
// and MT->MX mapping logic. Framework-agnostic — no MCP dependency here so it
// can be unit-tested or reused (e.g. inside Coexist) independently of the
// MCP transport layer.

// ---------- Low-level field validators ----------

function isValidBIC(bic) {
  if (typeof bic !== "string") return false;
  const clean = bic.trim().toUpperCase();
  // 8 or 11 chars: 4 letters (bank), 2 letters (country), 2 alnum (location), optional 3 alnum (branch)
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(clean);
}

// IBAN mod-97 checksum validation (ISO 7064)
function isValidIBAN(iban) {
  if (typeof iban !== "string") return false;
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;

  const rearranged = clean.slice(4) + clean.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());

  // mod-97 over a potentially huge numeric string, done in chunks
  let remainder = numeric;
  while (remainder.length > 9) {
    const chunk = remainder.slice(0, 9);
    remainder = (parseInt(chunk, 10) % 97).toString() + remainder.slice(9);
  }
  return parseInt(remainder, 10) % 97 === 1;
}

function isValidCurrency(code) {
  // Not exhaustive ISO 4217, but catches the common shape + common codes
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return false;
  return true;
}

// ---------- MT message parsing ----------

// Parses a raw MT block-4 style message body into { tag: value } pairs.
// Expects lines like ":20:REF12345" possibly multi-line for fields like :50K:/:59:
function parseMTFields(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const fields = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) {
      if (current) fields.push(current);
      current = { tag: m[1], value: m[2] };
    } else if (current && line.trim() !== "" && !line.startsWith("-")) {
      // continuation line for multi-line fields (e.g. :50K:, :59:, :70:)
      current.value += "\n" + line;
    }
  }
  if (current) fields.push(current);
  return fields;
}

const MT_RULES = {
  MT103: {
    mandatory: ["20", "23B", "32A", "50K", "59", "71A"],
    description: "Single Customer Credit Transfer",
  },
  MT202: {
    mandatory: ["20", "21", "32A", "58A"],
    description: "General Financial Institution Transfer",
  },
};

function validateMTMessage(messageType, raw) {
  const rules = MT_RULES[messageType];
  const errors = [];
  const warnings = [];

  if (!rules) {
    return {
      valid: false,
      errors: [`Unsupported message type "${messageType}". Supported: ${Object.keys(MT_RULES).join(", ")}`],
      warnings: [],
      fields: [],
    };
  }

  const fields = parseMTFields(raw);
  const tagsPresent = new Set(fields.map((f) => f.tag));

  for (const tag of rules.mandatory) {
    if (!tagsPresent.has(tag)) {
      errors.push(`Missing mandatory field :${tag}: (${fieldLabel(tag)})`);
    }
  }

  for (const f of fields) {
    switch (f.tag) {
      case "20": // Sender's Reference
        if (f.value.length > 16) errors.push(`:20: reference exceeds 16 characters ("${f.value}")`);
        if (/^\/|\/\/|\/$/.test(f.value)) errors.push(`:20: reference must not start/end with "/" or contain "//"`);
        break;
      case "32A": {
        // Format: 6!n3!a15d  -> YYMMDD + currency + amount
        const m = f.value.match(/^(\d{6})([A-Z]{3})([\d,]+)$/);
        if (!m) {
          errors.push(`:32A: does not match expected format YYMMDDCCCAMOUNT (got "${f.value}")`);
        } else {
          const [, date, ccy] = m;
          if (!isValidCurrency(ccy)) errors.push(`:32A: currency code "${ccy}" is not a valid 3-letter ISO code shape`);
          const mm = parseInt(date.slice(2, 4), 10);
          const dd = parseInt(date.slice(4, 6), 10);
          if (mm < 1 || mm > 12) errors.push(`:32A: invalid month in value date "${date}"`);
          if (dd < 1 || dd > 31) errors.push(`:32A: invalid day in value date "${date}"`);
        }
        break;
      }
      case "50K":
      case "59": {
        const firstLine = f.value.split("\n")[0].trim();
        if (firstLine.startsWith("/")) {
          const acct = firstLine.slice(1).trim();
          if (acct.length >= 15 && !isValidIBAN(acct)) {
            warnings.push(`:${f.tag}: account "${acct}" looks IBAN-length but fails IBAN checksum`);
          }
        }
        break;
      }
      case "58A":
      case "57A":
      case "59A": {
        const bicLine = f.value.split("\n").find((l) => l.trim().length > 0);
        if (bicLine && !isValidBIC(bicLine.trim())) {
          errors.push(`:${f.tag}: "${bicLine.trim()}" is not a valid BIC (expected 8 or 11 chars, 4 letters+2 letters+2 alnum[+3 alnum])`);
        }
        break;
      }
      case "71A": {
        if (!["BEN", "OUR", "SHA"].includes(f.value.trim())) {
          errors.push(`:71A: charges code must be BEN, OUR, or SHA (got "${f.value.trim()}")`);
        }
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, fields };
}

function fieldLabel(tag) {
  const labels = {
    "20": "Sender's Reference",
    "21": "Related Reference",
    "23B": "Bank Operation Code",
    "32A": "Value Date/Currency/Amount",
    "50K": "Ordering Customer",
    "58A": "Beneficiary Institution",
    "59": "Beneficiary Customer",
    "71A": "Details of Charges",
  };
  return labels[tag] || tag;
}

// ---------- MX (ISO 20022) validation ----------
// Lightweight structural validation (not full XSD) covering the fields that
// most commonly break in production: currency shape, BIC shape, IBAN
// checksum, and (per the Nov-2026 SWIFT milestone) structured vs
// unstructured postal address usage.

function validateMXMessage(messageType, xml) {
  const errors = [];
  const warnings = [];
  const supported = ["pacs.008", "pacs.009"];
  if (!supported.includes(messageType)) {
    return { valid: false, errors: [`Unsupported MX type "${messageType}". Supported: ${supported.join(", ")}`], warnings: [] };
  }

  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };
  const hasTag = (tag) => new RegExp(`<${tag}[\\s>]`).test(xml);

  const msgId = get("MsgId");
  if (!msgId) errors.push("Missing GrpHdr/MsgId");

  const ccy = xml.match(/Ccy="([A-Z]{3})"/);
  if (ccy && !isValidCurrency(ccy[1])) errors.push(`Currency attribute "${ccy[1]}" is not a valid ISO 4217 shape`);

  const bicMatches = [...xml.matchAll(/<BICFI>([^<]*)<\/BICFI>/g)];
  for (const m of bicMatches) {
    if (!isValidBIC(m[1])) errors.push(`BICFI "${m[1]}" is not a valid BIC`);
  }

  const ibanMatches = [...xml.matchAll(/<IBAN>([^<]*)<\/IBAN>/g)];
  for (const m of ibanMatches) {
    if (!isValidIBAN(m[1])) errors.push(`IBAN "${m[1]}" fails mod-97 checksum`);
  }

  // Nov 2026 SWIFT milestone: unstructured addresses no longer supported.
  if (hasTag("AdrLine") && !hasTag("StrtNm") && !hasTag("TwnNm")) {
    warnings.push(
      "Only unstructured postal address (AdrLine) found with no structured elements (StrtNm/TwnNm). " +
      "SWIFT's CBPR+ milestone removes support for unstructured addresses after November 2026 — " +
      "consider migrating to structured or hybrid address format now."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------- MT -> MX mapping (MT103 -> pacs.008, simplified) ----------

function mapMT103ToPacs008(raw) {
  const fields = parseMTFields(raw);
  const byTag = Object.fromEntries(fields.map((f) => [f.tag, f.value]));
  const notes = [];

  if (!byTag["20"]) notes.push("Missing :20: — MsgId will be empty, downstream system will likely reject");

  let valDate = null, ccy = null, amount = null;
  const m32A = (byTag["32A"] || "").match(/^(\d{6})([A-Z]{3})([\d,]+)$/);
  if (m32A) {
    const [, d, c, a] = m32A;
    valDate = `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`;
    ccy = c;
    amount = a.replace(",", ".");
  } else {
    notes.push(":32A: could not be parsed — IntrBkSttlmDt/Amt left blank");
  }

  const debtorLine = (byTag["50K"] || "").split("\n").filter(Boolean);
  const creditorLine = (byTag["59"] || "").split("\n").filter(Boolean);

  const pacs008 = {
    MsgId: byTag["20"] || "",
    IntrBkSttlmDt: valDate,
    IntrBkSttlmAmt: amount,
    Ccy: ccy,
    ChrgBr: { BEN: "DEBT", OUR: "DEBT", SHA: "SHAR" }[byTag["71A"]?.trim()] || null,
    Dbtr: { Nm: debtorLine.find((l) => !l.startsWith("/")) || null },
    DbtrAcct: debtorLine.find((l) => l.startsWith("/"))?.slice(1) || null,
    Cdtr: { Nm: creditorLine.find((l) => !l.startsWith("/")) || null },
    CdtrAcct: creditorLine.find((l) => l.startsWith("/"))?.slice(1) || null,
  };

  return { pacs008, notes };
}

// ---------- MT202 -> pacs.009 (Financial Institution Credit Transfer) ----------
// MT202 has no customer-level Dbtr/Cdtr — it moves money bank-to-bank, so the
// mapping targets Instructing/Instructed agents (52A/58A) rather than Dbtr/Cdtr.

function mapMT202ToPacs009(raw) {
  const fields = parseMTFields(raw);
  const byTag = Object.fromEntries(fields.map((f) => [f.tag, f.value]));
  const notes = [];

  if (!byTag["20"]) notes.push("Missing :20: — MsgId will be empty, downstream system will likely reject");
  if (!byTag["21"]) notes.push("Missing :21: (Related Reference) — EndToEndId will be left blank");

  let valDate = null, ccy = null, amount = null;
  const m32A = (byTag["32A"] || "").match(/^(\d{6})([A-Z]{3})([\d,]+)$/);
  if (m32A) {
    const [, d, c, a] = m32A;
    valDate = `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`;
    ccy = c;
    amount = a.replace(",", ".");
  } else {
    notes.push(":32A: could not be parsed — IntrBkSttlmDt/Amt left blank");
  }

  const firstBicLine = (tag) => {
    const v = byTag[tag];
    if (!v) return null;
    const line = v.split("\n").find((l) => l.trim().length > 0);
    return line ? line.trim() : null;
  };

  const instgAgtBic = firstBicLine("52A"); // Ordering Institution
  const instdAgtBic = firstBicLine("58A"); // Beneficiary Institution (mandatory)
  const intrmyAgtBic = firstBicLine("56A"); // Intermediary, if present

  if (instgAgtBic && !isValidBIC(instgAgtBic)) notes.push(`:52A: "${instgAgtBic}" does not look like a valid BIC — InstgAgt left as-is, verify manually`);
  if (instdAgtBic && !isValidBIC(instdAgtBic)) notes.push(`:58A: "${instdAgtBic}" does not look like a valid BIC — InstdAgt left as-is, verify manually`);

  const pacs009 = {
    MsgId: byTag["20"] || "",
    EndToEndId: byTag["21"] || "",
    IntrBkSttlmDt: valDate,
    IntrBkSttlmAmt: amount,
    Ccy: ccy,
    InstgAgt: instgAgtBic ? { BICFI: instgAgtBic } : null,
    InstdAgt: instdAgtBic ? { BICFI: instdAgtBic } : null,
    IntrmyAgt1: intrmyAgtBic ? { BICFI: intrmyAgtBic } : null,
  };

  return { pacs009, notes };
}

// ---------- Reverse direction: MX -> MT (pacs.008 -> MT103) ----------
// Useful during the SWIFT coexistence period when a system receives MX but a
// downstream system still expects MT. This is deliberately conservative:
// it only maps fields it can extract with confidence and flags the rest.

function mapPacs008ToMT103(xml) {
  const notes = [];
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? m[1].trim() : null;
  };

  const msgId = get("MsgId");
  const sttlmDt = get("IntrBkSttlmDt"); // expected YYYY-MM-DD
  const amtMatch = xml.match(/<IntrBkSttlmAmt Ccy="([A-Z]{3})">([\d.]+)<\/IntrBkSttlmAmt>/);
  const dbtrBlock = xml.match(/<Dbtr>([\s\S]*?)<\/Dbtr>/);
  const dbtrNm = dbtrBlock ? (dbtrBlock[1].match(/<Nm>([^<]*)<\/Nm>/) || [])[1]?.trim() || null : null;
  const cdtrIban = get("IBAN");
  const chrgBr = get("ChrgBr");

  if (!msgId) notes.push("No MsgId found — :20: will be empty");

  let mt32A = null;
  if (sttlmDt && amtMatch) {
    const d = sttlmDt.replace(/-/g, "").slice(2); // YYMMDD
    mt32A = `${d}${amtMatch[1]}${amtMatch[2].replace(".", ",")}`;
  } else {
    notes.push("Could not build :32A: — missing IntrBkSttlmDt or IntrBkSttlmAmt");
  }

  const chargesMap = { DEBT: "OUR", CRED: "BEN", SHAR: "SHA" };
  const mt71A = chargesMap[chrgBr] || null;
  if (chrgBr && !mt71A) notes.push(`ChrgBr "${chrgBr}" has no direct MT mapping — :71A: left blank, verify manually`);
  if (!chrgBr) notes.push("No ChrgBr found — :71A: left blank");

  if (!dbtrNm) notes.push("Could not confidently extract Dbtr name from XML — check nesting, :50K: left blank");
  if (!cdtrIban) notes.push("No IBAN found for creditor account — :59: account line left blank");

  const mt103Fields = {
    "20": msgId || "",
    "23B": "CRED",
    "32A": mt32A,
    "50K": dbtrNm ? `/\n${dbtrNm}` : null,
    "59": cdtrIban ? `/${cdtrIban}` : null,
    "71A": mt71A,
  };

  return { mt103Fields, notes };
}

// Generic dispatcher so a caller doesn't need to know the exact function name
// per direction/message-type pair.
function mapMTtoMX(messageType, raw) {
  if (messageType === "MT103") return { targetType: "pacs.008", ...mapMT103ToPacs008(raw) };
  if (messageType === "MT202") return { targetType: "pacs.009", ...mapMT202ToPacs009(raw) };
  throw new Error(`No MT->MX mapping defined for "${messageType}". Supported: MT103, MT202`);
}

module.exports = {
  isValidBIC,
  isValidIBAN,
  isValidCurrency,
  parseMTFields,
  validateMTMessage,
  validateMXMessage,
  mapMT103ToPacs008,
  mapMT202ToPacs009,
  mapPacs008ToMT103,
  mapMTtoMX,
  MT_RULES,
};
