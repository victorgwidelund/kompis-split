import test from "node:test";
import assert from "node:assert/strict";
import {
  OCR_BENCHMARK_SCHEMA_VERSION,
  aggregateOcrScoresV2,
  matchOcrBenchmarkItemsV2,
  scoreOcrFixtureV2,
} from "../dist/ocr-benchmark.js";

const item = (name, lineTotalOre, overrides = {}) => ({
  id: name, rawName: name, normalizedName: name, kind: "product", quantity: 1, unit: "st",
  unitPriceOre: lineTotalOre, lineTotalOre, weightGrams: null, multipack: null,
  discountOre: null, pantOre: null, ...overrides,
});

const receipt = (overrides = {}) => ({
  merchant: "ICA Nära", date: "2026-08-26", time: null, receiptNumber: null, currency: "SEK",
  items: [item("Mjölk", 1990)], subtotalOre: 1990, discounts: [], vat: [], totalOre: 1990,
  pantTotalOre: null, payments: [], ...overrides,
});

const truth = (overrides = {}) => ({
  schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION, id: "fixture", category: "grocery", difficulty: "normal",
  split: "dev", receipt: receipt(), rejectedMetadata: ["MOMS 12%"], reviewExpected: false, ...overrides,
});

const success = (overrides = {}) => ({
  schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION, status: "success", receipt: receipt(), source: "test",
  needsReview: false, failureStage: null, failureCode: null, latencyMs: 100,
  stageLatencyMs: { ocr: 70, parsing: 10, validation: 5 }, ...overrides,
});

test("schema-v2 matching is one-to-one and classifies repeated predictions as duplicates", () => {
  const predicted = receipt({ items: [item("Mjölk", 1990), item("Mjölk", 1990)] });
  const score = scoreOcrFixtureV2(truth(), success({ receipt: predicted }));
  assert.equal(score.matchedItemCount, 1);
  assert.equal(score.extraItemCount, 1);
  assert.equal(score.duplicateItemCount, 1);
  assert.equal(score.hallucinatedItemCount, 0);

  const matching = matchOcrBenchmarkItemsV2(
    [item("Kaffe mörkrost", 4990), item("Kaffe", 2990)],
    [item("Kaffe", 2990), item("Kaffe mörkrost", 4990)],
  );
  assert.deepEqual(matching.matches.map(({ truthIndex, predictedIndex }) => [truthIndex, predictedIndex]), [[0, 1], [1, 0]]);
});

test("failed scans stay in accuracy denominators and preserve failure-stage evidence", () => {
  const failed = {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION, status: "failure", receipt: null, source: null,
    needsReview: null, failureStage: "ocr", failureCode: "timeout", latencyMs: 5000,
    stageLatencyMs: { preprocessing: 25, ocr: 4975 },
  };
  const aggregate = aggregateOcrScoresV2([
    scoreOcrFixtureV2(truth({ id: "ok" }), success()),
    scoreOcrFixtureV2(truth({ id: "failed" }), failed),
  ]);
  assert.ok(aggregate);
  assert.equal(aggregate.scanSuccessRate, 0.5);
  assert.equal(aggregate.totalAccuracy, 0.5);
  assert.equal(aggregate.itemRecall, 0.5);
  assert.equal(aggregate.failureCountsByStage.ocr, 1);
  assert.equal(aggregate.latency.p95Ms, 4755);
  assert.equal(aggregate.stageLatency.ocr.count, 2);
});

test("discount arithmetic and evidence-based review calibration are scored independently", () => {
  const discounted = receipt({
    items: [item("Kaffe", 5000)], subtotalOre: 5000,
    discounts: [{ id: "d1", label: "Medlemsrabatt", amountOre: 1000, itemId: null }], totalOre: 4000,
  });
  const score = scoreOcrFixtureV2(
    truth({ receipt: discounted, reviewExpected: true }),
    success({ receipt: discounted, needsReview: true }),
  );
  assert.equal(score.arithmeticConsistent, true);
  assert.equal(score.arithmeticDeltaOre, 0);
  assert.equal(score.discountAmountCorrect, 1);
  assert.equal(score.reviewOutcome, "true-positive");
});

test("invented nullable fields and rejected metadata rows count as hallucinations", () => {
  const predicted = receipt({
    time: "12:34", receiptNumber: "1234",
    items: [item("Mjölk", 1990), item("MOMS 12%", 214)],
  });
  const score = scoreOcrFixtureV2(truth(), success({ receipt: predicted }));
  assert.equal(score.metadataHallucinationCount, 3);
  assert.ok(score.metadataHallucinations.includes("time:12:34"));
  assert.ok(score.metadataHallucinations.includes("receiptNumber:1234"));
  assert.ok(score.metadataHallucinations.includes("MOMS 12%"));
  assert.equal(score.hallucinatedItemCount, 1);
});
