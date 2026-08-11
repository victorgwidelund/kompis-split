import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { closeReceiptOcr, combineReceiptPasses, parseOllamaReceipt, parseReceiptText, prepareReceiptImages, recognizeReceipt } from "../dist/receipt-ocr.js";

test("Swedish receipt fields are extracted as editable suggestions", () => {
  const suggestion = parseReceiptText(`
    RESTAURANG HÖRNET
    Storgatan 1 Stockholm
    Datum 2026-08-10 19:42
    Mat 100,00
    Moms 12% 132,00
    TOTALT 1 234,50
  `, new Date("2026-08-11T12:00:00Z"));
  assert.deepEqual(suggestion, {
    title: "RESTAURANG HÖRNET",
    amount: "1234.50",
    expenseDate: "2026-08-10",
    category: "food",
    items: [{ name: "Mat", quantity: 1, amount: "100.00" }],
  });
});

test("receipt rows and quantities are extracted for quick tab claiming", () => {
  const suggestion = parseReceiptText(`
    BISTRO KAJEN
    2 x Lager 65,00 130,00
    Fish and chips 189,00
    MOMS 34,18
    ATT BETALA 319,00
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Lager", quantity: 2, amount: "130.00" },
    { name: "Fish and chips", quantity: 1, amount: "189.00" },
  ]);
});

test("compact quantity prefixes are kept and payment rows are excluded", () => {
  const suggestion = parseReceiptText(`
    KVÄLLSKROGEN
    Produkt Pris
    3x Mariestad 261.00
    7x Smirnoff ICE 665.00
    TOTALT SEK 926.00
    Betalt SEK 926.00
  `);
  assert.equal(suggestion.amount, "926.00");
  assert.deepEqual(suggestion.items, [
    { name: "Mariestad", quantity: 3, amount: "261.00" },
    { name: "Smirnoff ICE", quantity: 7, amount: "665.00" },
  ]);
});

test("missing OCR decimal separators are repaired without treating card IDs as products", () => {
  const suggestion = parseReceiptText(`
    Mixed Grill 595 00
    Heineken 13000
    Extra SEK 168 .00
    Total SEK 893.00
    CTUIDSISTCSKSA000000011
    AID A000000004 1010
    TVR 0000008001
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Mixed Grill", quantity: 1, amount: "595.00" },
    { name: "Heineken", quantity: 1, amount: "130.00" },
    { name: "Extra", quantity: 1, amount: "168.00" },
  ]);
});

test("iPhone preview chrome and margins are cropped before OCR", async () => {
  const screenshot = await sharp(Buffer.from(`<svg width="590" height="1280" xmlns="http://www.w3.org/2000/svg">
    <rect width="590" height="1280" fill="#fffdfd"/>
    <rect width="590" height="148" fill="#4b4b4b"/>
    <rect x="188" y="162" width="214" height="948" fill="#fff" stroke="#111" stroke-width="3"/>
    <text x="220" y="300" font-size="22" fill="#222">KVITTO</text>
    <text x="215" y="440" font-size="18" fill="#222">3x Dryck 261.00</text>
    <text x="215" y="500" font-size="18" fill="#222">TOTAL 261.00</text>
  </svg>`)).png().toBuffer();
  const prepared = await prepareReceiptImages(screenshot);
  assert.equal(prepared.crop.screenshotPreview, true);
  assert.ok(prepared.crop.left > 140);
  assert.ok(prepared.crop.width < 330);
  assert.ok(prepared.crop.top >= 140);
});

test("phone photos with OCR borders and decimal quantities preserve receipt rows", () => {
  const suggestion = parseReceiptText(`
    | Förhandsvisning |
    VASE230109 #23 : 21719 |
    Framsida
    tis 26 maj 26 18:10
    | 1.00 Chipspåse FS 49,00 |
    | 1.00 Valenciamandlar burk 80,00 |
    | 6.00 Heineken Draft (90.00) 540.00 |
    Total 669.00 |
    Moms% Moms ExMoms Total |
  `, new Date("2026-05-27T12:00:00Z"));
  assert.equal(suggestion.title, "Framsida");
  assert.equal(suggestion.amount, "669.00");
  assert.equal(suggestion.expenseDate, "2026-05-26");
  assert.deepEqual(suggestion.items, [
    { name: "Chipspåse FS", quantity: 1, amount: "49.00" },
    { name: "Valenciamandlar burk", quantity: 1, amount: "80.00" },
    { name: "Heineken Draft", quantity: 6, amount: "540.00" },
  ]);
});

test("wrapped receipt totals and OCR zero glyphs preserve a beer line", () => {
  const suggestion = parseReceiptText(`
    FRAMSIDAN
    1.OO Chipspåse 49.OO
    6.OO Heineken Draft (9O.OO)
    54O.OO
    Total 589.OO
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Chipspåse", quantity: 1, amount: "49.00" },
    { name: "Heineken Draft", quantity: 6, amount: "540.00" },
  ]);
  assert.equal(suggestion.amount, "589.00");
});

test("local AI receipt output is validated and merged by exact öre", () => {
  const ai = parseOllamaReceipt({
    merchant: "Framsidan", date: "2026-05-26", total: 669,
    items: [{ name: "Heineken Draft", quantity: 6, amount: 540 }],
  }, new Date("2026-05-27T12:00:00Z"));
  assert.ok(ai);
  const tesseract = {
    text: "", confidence: 59,
    suggestion: {
      title: "Framsidan", amount: "669.00", expenseDate: "2026-05-26", category: "food",
      items: [
        { name: "Chipspåse FS", quantity: 1, amount: "49.00" },
        { name: "Valenciamandlar burk", quantity: 1, amount: "80.00" },
      ],
    },
  };
  const combined = combineReceiptPasses([ai, tesseract]);
  assert.equal(combined.suggestion.items.reduce((sum, item) => sum + Number(item.amount), 0), 669);
  assert.deepEqual(combined.suggestion.items.map((item) => item.name), ["Chipspåse FS", "Valenciamandlar burk", "Heineken Draft"]);
});

test("structured vision output keeps row totals, quantities and exact receipt total", () => {
  const ai = parseOllamaReceipt({
    merchant: "Restaurangen", date: "", total: 2400,
    items: [
      { name: "Friterade risottobollar", quantity: 1, amount: 80 },
      { name: "Ostron Flambadou", quantity: 2, amount: 110 },
      { name: "Rödräka Pil Pil", quantity: 1, amount: 89 },
      { name: "Saltgurka", quantity: 1, amount: 50 },
      { name: "Mixed Grill", quantity: 1, amount: 595 },
      { name: "Heineken", quantity: 1, amount: 130 },
      { name: "Flaska vin", quantity: 1, amount: 950 },
      { name: "Öl", quantity: 1, amount: 79 },
      { name: "Negroni", quantity: 1, amount: 149 },
      { name: "Extra", quantity: 1, amount: 168 },
    ],
  });
  assert.ok(ai);
  assert.equal(ai.suggestion.amount, "2400.00");
  assert.equal(ai.suggestion.items.reduce((sum, item) => sum + Number(item.amount), 0), 2400);
  assert.deepEqual(ai.suggestion.items[1], { name: "Ostron Flambadou", quantity: 2, amount: "110.00" });
});

test("receipt parser handles European dates and ignores headings as merchants", () => {
  const suggestion = parseReceiptText(`
    KASSAKVITTO
    ICA MAXI HÄGGVIK
    10/08/2026 14:02
    DELSUMMA 275,00
    ATT BETALA 299,00 SEK
  `, new Date("2026-08-11T12:00:00Z"));
  assert.equal(suggestion.title, "ICA MAXI HÄGGVIK");
  assert.equal(suggestion.amount, "299.00");
  assert.equal(suggestion.expenseDate, "2026-08-10");
  assert.equal(suggestion.category, "food");
});

test("invalid and future dates are not suggested", () => {
  const suggestion = parseReceiptText("HOTELL NORR\nDATUM 31/02/2026\nTOTAL 850,00", new Date("2026-01-10T12:00:00Z"));
  assert.equal(suggestion.title, "HOTELL NORR");
  assert.equal(suggestion.expenseDate, null);
  assert.equal(suggestion.category, "stay");
});

test("two bundled Swedish OCR workers can process receipts concurrently", { timeout: 30_000 }, async () => {
  try {
    const blankImage = await sharp({ create: { width: 320, height: 120, channels: 3, background: "white" } }).png().toBuffer();
    const results = await Promise.all([recognizeReceipt(blankImage), recognizeReceipt(blankImage)]);
    for (const result of results) {
      assert.equal(result.suggestion.amount, null);
      assert.equal(result.suggestion.category, "other");
    }
  } finally {
    await closeReceiptOcr();
  }
});
