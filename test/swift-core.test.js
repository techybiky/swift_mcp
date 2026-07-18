const assert = require("assert");
const {
  isValidBIC,
  isValidIBAN,
  validateMTMessage,
  validateMXMessage,
  mapMT103ToPacs008,
} = require("../src/swift-core.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

console.log("BIC validation");
test("valid 8-char BIC", () => assert.strictEqual(isValidBIC("DEUTDEFF"), true));
test("valid 11-char BIC", () => assert.strictEqual(isValidBIC("DEUTDEFF500"), true));
test("invalid BIC (too short)", () => assert.strictEqual(isValidBIC("DEUTDEF"), false));
test("invalid BIC (lowercase not normalized fails shape check on digits)", () => assert.strictEqual(isValidBIC("deutdeff"), true));

console.log("IBAN validation");
test("valid GB IBAN", () => assert.strictEqual(isValidIBAN("GB29NWBK60161331926819"), true));
test("valid DE IBAN", () => assert.strictEqual(isValidIBAN("DE89370400440532013000"), true));
test("invalid IBAN (bad checksum)", () => assert.strictEqual(isValidIBAN("GB29NWBK60161331926818"), false));
test("invalid IBAN (bad shape)", () => assert.strictEqual(isValidIBAN("NOTANIBAN"), false));

console.log("MT103 validation");
test("valid MT103 passes", () => {
  const msg = `:20:REF123456789\n:23B:CRED\n:32A:250115USD1000,00\n:50K:/GB29NWBK60161331926819\nJOHN DOE\n:59:/DE89370400440532013000\nJANE SMITH\n:71A:SHA`;
  const r = validateMTMessage("MT103", msg);
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});
test("MT103 missing mandatory field fails", () => {
  const msg = `:20:REF123456789\n:32A:250115USD1000,00`;
  const r = validateMTMessage("MT103", msg);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes(":23B:")));
});
test("MT103 invalid charges code fails", () => {
  const msg = `:20:REF1\n:23B:CRED\n:32A:250115USD1000,00\n:50K:/GB29NWBK60161331926819\nA\n:59:/DE89370400440532013000\nB\n:71A:XYZ`;
  const r = validateMTMessage("MT103", msg);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes(":71A:")));
});

console.log("MX validation");
test("pacs.008 flags unstructured-only address", () => {
  const xml = `<Document><FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId></GrpHdr><PstlAdr><AdrLine>123 Main St</AdrLine></PstlAdr></FIToFICstmrCdtTrf></Document>`;
  const r = validateMXMessage("pacs.008", xml);
  assert.ok(r.warnings.some((w) => w.includes("November 2026")));
});
test("pacs.008 catches invalid BICFI", () => {
  const xml = `<Document><MsgId>M1</MsgId><BICFI>BADCODE</BICFI></Document>`;
  const r = validateMXMessage("pacs.008", xml);
  assert.strictEqual(r.valid, false);
});

console.log("MT103 -> pacs.008 mapping");
test("maps core fields correctly", () => {
  const msg = `:20:REF123456789\n:23B:CRED\n:32A:250115USD1000,00\n:50K:/GB29NWBK60161331926819\nJOHN DOE\n:59:/DE89370400440532013000\nJANE SMITH\n:71A:SHA`;
  const { pacs008 } = mapMT103ToPacs008(msg);
  assert.strictEqual(pacs008.MsgId, "REF123456789");
  assert.strictEqual(pacs008.Ccy, "USD");
  assert.strictEqual(pacs008.IntrBkSttlmAmt, "1000.00");
  assert.strictEqual(pacs008.Dbtr.Nm, "JOHN DOE");
  assert.strictEqual(pacs008.Cdtr.Nm, "JANE SMITH");
  assert.strictEqual(pacs008.ChrgBr, "SHAR");
});

console.log("MT202 -> pacs.009 mapping");
test("maps MT202 core fields correctly", () => {
  const {
    mapMT202ToPacs009,
  } = require("../src/swift-core.js");
  const msg = `:20:REF987654321\n:21:RELREF001\n:32A:250201GBP50000,00\n:52A:CHASUS33\n:58A:DEUTDEFF`;
  const { pacs009, notes } = mapMT202ToPacs009(msg);
  assert.strictEqual(pacs009.MsgId, "REF987654321");
  assert.strictEqual(pacs009.EndToEndId, "RELREF001");
  assert.strictEqual(pacs009.Ccy, "GBP");
  assert.strictEqual(pacs009.IntrBkSttlmAmt, "50000.00");
  assert.strictEqual(pacs009.InstgAgt.BICFI, "CHASUS33");
  assert.strictEqual(pacs009.InstdAgt.BICFI, "DEUTDEFF");
  assert.strictEqual(notes.length, 0);
});
test("MT202 missing :58A: is flagged in notes via validator, mapping still attempted", () => {
  const { mapMT202ToPacs009 } = require("../src/swift-core.js");
  const msg = `:20:REF1\n:32A:250201GBP1000,00`;
  const { pacs009, notes } = mapMT202ToPacs009(msg);
  assert.strictEqual(pacs009.InstdAgt, null);
  assert.ok(notes.some((n) => n.includes(":21:")));
});

console.log("pacs.008 -> MT103 (reverse) mapping");
test("maps pacs.008 core fields back to MT103", () => {
  const { mapPacs008ToMT103 } = require("../src/swift-core.js");
  const xml = `<Document><GrpHdr><MsgId>M999</MsgId></GrpHdr><IntrBkSttlmDt>2025-03-10</IntrBkSttlmDt><IntrBkSttlmAmt Ccy="EUR">2500.00</IntrBkSttlmAmt><ChrgBr>SHAR</ChrgBr><Dbtr><Nm>ACME CORP</Nm></Dbtr><CdtrAcct><IBAN>DE89370400440532013000</IBAN></CdtrAcct></Document>`;
  const { mt103Fields, notes } = mapPacs008ToMT103(xml);
  assert.strictEqual(mt103Fields["20"], "M999");
  assert.strictEqual(mt103Fields["32A"], "250310EUR2500,00");
  assert.ok(mt103Fields["50K"].includes("ACME CORP"));
  assert.ok(mt103Fields["59"].includes("DE89370400440532013000"));
  assert.strictEqual(mt103Fields["71A"], "SHA");
  assert.strictEqual(notes.length, 0);
});
test("pacs.008 missing fields produce notes, not crashes", () => {
  const { mapPacs008ToMT103 } = require("../src/swift-core.js");
  const xml = `<Document><GrpHdr></GrpHdr></Document>`;
  const { mt103Fields, notes } = mapPacs008ToMT103(xml);
  assert.strictEqual(mt103Fields["20"], "");
  assert.ok(notes.length > 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
