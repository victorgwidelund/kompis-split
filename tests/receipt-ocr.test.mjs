import test from "node:test";
import assert from "node:assert/strict";
import { closeReceiptOcr, parseReceiptText, recognizeReceipt } from "../dist/receipt-ocr.js";

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
    Mat 1 100,00
    Moms 12% 132,00
    TOTALT 1 234,50
  `, new Date("2026-08-11T12:00:00Z"));
  assert.deepEqual(suggestion, {
    title: "RESTAURANG HÖRNET",
    amount: "1234.50",
    expenseDate: "2026-08-10",
    category: "food",
  });
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
