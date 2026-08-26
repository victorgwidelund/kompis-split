import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredReceipt } from "../dist/receipt-ocr.js";

test("structured Swedish receipt parsing preserves explicit quantities, weight, discounts, VAT and evidence", () => {
  const text = `ICA Nära Torget
2026-08-26 18:42
Kvitto nr AB-1234
2 x Mjölk à 19,90 39,80
Banan 0,742 kg x 29,90 22,19
Pant 2 st 4,00
Delsumma 65,99
Medlemsrabatt -10,00
MOMS 12% 49,99 6,00 55,99
TOTAL 55,99
Kort 55,99`;
  const { receipt, validation } = parseStructuredReceipt(text, 94, new Date("2026-08-27T00:00:00Z"));

  assert.equal(receipt.merchant, "ICA Nära Torget");
  assert.equal(receipt.date, "2026-08-26");
  assert.equal(receipt.time, "18:42");
  assert.equal(receipt.receiptNumber, "AB-1234");
  assert.equal(receipt.totalOre, 5599);
  assert.equal(receipt.subtotalOre, 6599);
  assert.equal(receipt.discounts[0].amountOre, 1000);
  assert.equal(receipt.items.length, 3);
  assert.equal(receipt.items[0].quantity, 2);
  assert.equal(receipt.items[0].unitPriceOre, 1990);
  assert.equal(receipt.items[1].quantity, 0.742);
  assert.equal(receipt.items[1].unit, "kg");
  assert.equal(receipt.items[1].weightGrams, 742);
  assert.equal(receipt.items[2].kind, "pant");
  assert.equal(receipt.pantTotalOre, 400);
  assert.equal(receipt.vat[0].rateBasisPoints, 1200);
  assert.equal(receipt.payments[0].method, "kort");
  assert.equal(validation.arithmeticDeltaOre, 0);
  assert.equal(validation.needsReview, false);
  assert.ok(receipt.items.every((item) => item.evidence.lineIndexes.length === 1));
});

test("structured parsing leaves absent fields null and flags impossible arithmetic", () => {
  const { receipt, validation } = parseStructuredReceipt("Butiken\nVara 20,00\nTOTAL 10,00", 90);
  assert.equal(receipt.date, null);
  assert.equal(receipt.time, null);
  assert.equal(receipt.receiptNumber, null);
  assert.equal(receipt.currency, null);
  assert.equal(validation.arithmeticDeltaOre, 1000);
  assert.equal(validation.needsReview, true);
  assert.ok(validation.signals.some((signal) => signal.code === "total_mismatch" && signal.severity === "error"));
});

test("fused Swedish multipliers preserve quantity, name, unit price and line total", () => {
  const { receipt, validation } = parseStructuredReceipt("Baren\n2xNachos 90,61 181,22\nTOTAL 181,22", 98);
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].rawName, "Nachos");
  assert.equal(receipt.items[0].quantity, 2);
  assert.equal(receipt.items[0].unitPriceOre, 9061);
  assert.equal(receipt.items[0].lineTotalOre, 18122);
  assert.equal(validation.arithmeticDeltaOre, 0);
});
