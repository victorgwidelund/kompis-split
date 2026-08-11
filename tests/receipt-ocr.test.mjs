import test from "node:test";
import assert from "node:assert/strict";
import { closeReceiptOcr, combineReceiptPasses, parseOllamaReceipt, parseReceiptText, recognizeReceipt } from "../dist/receipt-ocr.js";

function blankBitmap(width = 320, height = 120) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const bitmap = Buffer.alloc(54 + imageSize, 255);
  bitmap.write("BM", 0, "ascii");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(imageSize, 34);
  return bitmap;
}

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

test("the bundled Swedish OCR model works without an external service", { timeout: 30_000 }, async () => {
  try {
    const result = await recognizeReceipt(blankBitmap());
    assert.equal(result.suggestion.amount, null);
    assert.equal(result.suggestion.category, "other");
  } finally {
    await closeReceiptOcr();
  }
});
