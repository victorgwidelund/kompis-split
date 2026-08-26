// Fast, deterministic coverage for src/ocr-benchmark.ts (compiled to dist/ocr-benchmark.js) -- the
// module the in-app admin "OCR-benchmark" panel and tests/ocr-benchmark/run-benchmark.mjs both use.
// Runs the parser-only path only (no OCR/GPU), so this is safe for normal CI. It exercises the module's
// OWN corpus path resolution (relative to dist/), which is a different code path than the standalone
// CLI tool's resolution (relative to its own file) -- a regression in one would not necessarily show up
// in the other, so both are worth covering.
import test from "node:test";
import assert from "node:assert/strict";
import { ocrBenchmarkAvailable, loadOcrBenchmarkCorpus, runOcrBenchmarkParser } from "../dist/ocr-benchmark.js";

test("the benchmark corpus is available at the path src/ocr-benchmark.ts resolves relative to dist/", () => {
  assert.equal(ocrBenchmarkAvailable(), true);
});

test("the corpus loads a substantial dev set and the historical regression set", async () => {
  const dev = await loadOcrBenchmarkCorpus("dev");
  const legacy = await loadOcrBenchmarkCorpus("legacy");
  assert.ok(dev.length >= 40, `expected a real dev set, got ${dev.length}`);
  assert.ok(legacy.length >= 20, `expected a real legacy set, got ${legacy.length}`);
  assert.ok(dev.every((fixture) => fixture.groundTruth.split === "dev"));
  assert.ok(legacy.every((fixture) => fixture.groundTruth.split === "legacy"));
});

test("the parser-only benchmark scores near-perfectly against ideal OCR text on public fixtures", async () => {
  // Not pinned to exactly 100% -- this guards against a real regression in receipt-ocr.ts or in this
  // module's own scoring, not against the corpus being regenerated slightly differently later.
  const report = await runOcrBenchmarkParser("all-public");
  assert.equal(report.mode, "parser");
  assert.ok(report.overall, "expected an overall aggregate for a non-empty corpus");
  assert.ok(report.overall.merchantAccuracy >= 0.95, `merchant accuracy regressed: ${report.overall.merchantAccuracy}`);
  assert.ok(report.overall.dateAccuracy >= 0.95, `date accuracy regressed: ${report.overall.dateAccuracy}`);
  assert.ok(report.overall.itemF1 >= 0.95, `item F1 regressed: ${report.overall.itemF1}`);
  assert.ok(report.overall.priceAccuracy >= 0.95, `price accuracy regressed: ${report.overall.priceAccuracy}`);
  assert.equal(report.overall.falseMetadataItemsTotal, 0, "no metadata line should ever become a purchased item");
  // A real discount receipt legitimately fails exact reconciliation by design (see OCR_BENCHMARK.md) --
  // reconciledAfterKnownAdjustments is the metric that should still be exact.
  assert.ok(report.dev && report.dev.reconciledAfterKnownAdjustments === 1, "dev split should fully reconcile once known discounts are accounted for");
  assert.ok(report.legacy && report.legacy.reconciledAfterKnownAdjustments === 1, "legacy split should fully reconcile once known discounts are accounted for");
  assert.equal(report.overall.receiptsNeedingReview, 0, "known discounts must not be reported as OCR review failures");
});
